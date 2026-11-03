//! Rubric on NEAR: pay on proof, not on trust.
//!
//! A poster seals a task: its acceptance clauses and the money go into this contract in one
//! call, and from then on nobody can change the clauses. A worker submits. An AI judge, the one
//! account this contract accepts a verdict from, rules clause by clause off-chain and records
//! the verdict here. On approval the contract pays the worker; on rejection it refunds the
//! poster. If nobody rules, the poster can reclaim after a deadline.
//!
//! READ THIS FIRST, THE SHAPE OF THE MONEY
//!
//! * Money only ever leaves through `pay`, which runs after state has already been updated
//!   (so a second call cannot pay twice), and finishes in `on_payout`, which records whether the
//!   transfer really landed. NEAR transfers are asynchronous and can fail (for example if the
//!   receiver account was deleted), so "I sent it" is never assumed.
//! * `Settled` and `Refunded` are terminal. No function moves a task out of them.
//! * The judge cannot settle below `MIN_CONFIDENCE`. The AI's verdict is the authorisation to
//!   release funds, so a verdict the AI itself is unsure about must not be able to.
//! * The 2% fee is accrued in this contract and pulled by the owner. It is not pushed at
//!   settlement, so a bad fee destination can never block a worker's payout.
//! * Each task's storage is paid for by the poster, up front, at its worst-case size. Later
//!   growth (a worker, a verdict, a payout record) is therefore already funded, and nobody can
//!   drain the contract by making tasks bigger.
//!
//! This contract is unaudited and meant for testnet.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The protocol fee: 2%, in basis points. A constant, not a setting, so nobody can change it.
pub const FEE_BPS: u128 = 200;
const BPS_DENOMINATOR: u128 = 10_000;

/// The judge must be at least this confident (0-100) for the contract to accept its verdict.
pub const MIN_CONFIDENCE: u8 = 70;

/// Clause limits. Counted in characters, not bytes.
pub const MAX_CLAUSES: usize = 8;
pub const MAX_CLAUSE_CHARS: usize = 280;
pub const MAX_TITLE_CHARS: usize = 120;

/// The smallest bounty: 0.001 NEAR. Anything smaller is dust.
pub const MIN_BOUNTY: u128 = 1_000_000_000_000_000_000_000;

/// The ceiling on the bounty cap, however the owner configures it: 100 NEAR.
pub const ABSOLUTE_MAX_BOUNTY: u128 = 100 * 1_000_000_000_000_000_000_000_000;

/// Longest work window a task may set: 30 days. Without it a poster could set a deadline so far
/// away that reclaiming is unreachable.
pub const MAX_WINDOW_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;

/// The tag the clause hash is computed under. Bump it if the canonical form ever changes.
const HASH_DOMAIN: &str = "rubric-near/v1";

/// Gas reserved for the payout callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Most tasks `get_tasks` returns in one call.
const MAX_PAGE: u64 = 50;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskState {
    /// Sealed and funded; waiting for a worker.
    Open,
    /// A worker has submitted; waiting for the judge.
    Submitted,
    /// The judge approved. Terminal.
    Settled,
    /// The judge rejected, or the poster reclaimed. Terminal.
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    /// The transfer has been sent and its result is not known yet.
    Pending,
    /// The transfer landed.
    Paid,
    /// The transfer failed. The money is still held by this contract; `retry_payout` sends it again.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Verdict {
    pub approved: bool,
    /// 0-100, and never below `MIN_CONFIDENCE` here: the contract refuses a verdict under it.
    pub confidence: u8,
    /// SHA-256 (hex) of the judge's full public reasoning.
    pub reasoning_hash: String,
    pub decided_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub to: AccountId,
    pub amount: U128,
    /// The fee taken out of the bounty. Zero on a refund.
    pub fee: U128,
    pub status: PayoutStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Task {
    pub id: U64,
    pub poster: AccountId,
    pub title: String,
    /// The sealed acceptance clauses. Immutable once stored.
    pub clauses: Vec<String>,
    /// SHA-256 (hex) of the canonical form of title and clauses, computed HERE, not supplied.
    pub clauses_hash: String,
    /// yoctoNEAR escrowed for this task.
    pub bounty: U128,
    pub created_ns: U64,
    pub deadline_ns: U64,
    pub state: TaskState,
    pub worker: Option<AccountId>,
    pub submission_hash: Option<String>,
    pub submitted_ns: Option<U64>,
    pub verdict: Option<Verdict>,
    pub payout: Option<Payout>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub judge_id: AccountId,
    pub fee_bps: u16,
    pub min_confidence: u8,
    pub max_bounty: U128,
    pub verdict_grace_ns: U64,
    pub tasks_total: U64,
}

/// Where the money is. `escrow_held + fees_accrued` is what this contract owes; the contract's
/// balance should always be at least that, plus its storage reserve.
#[near(serializers = [json])]
pub struct Accounting {
    pub escrow_held: U128,
    pub fees_accrued: U128,
    pub contract_balance: U128,
}

#[near(event_json(standard = "rubric"))]
pub enum RubricEvent {
    #[event_version("1.0.0")]
    Sealed { task_id: U64, poster: AccountId, bounty: U128, clauses_hash: String, deadline_ns: U64 },
    #[event_version("1.0.0")]
    Submitted { task_id: U64, worker: AccountId, submission_hash: String },
    #[event_version("1.0.0")]
    Settled { task_id: U64, approved: bool, confidence: u8, reasoning_hash: String },
    #[event_version("1.0.0")]
    Reclaimed { task_id: U64 },
    #[event_version("1.0.0")]
    PayoutResult { task_id: U64, to: AccountId, amount: U128, paid: bool },
    #[event_version("1.0.0")]
    JudgeChanged { old: AccountId, new: AccountId },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Can rotate the judge, change the bounty cap and withdraw fees. Cannot touch escrow.
    owner_id: AccountId,
    /// The only account whose verdict this contract accepts.
    judge_id: AccountId,
    max_bounty: u128,
    /// How long after the deadline a task stuck in `Submitted` waits before the poster may reclaim.
    verdict_grace_ns: u64,
    next_task_id: u64,
    tasks: LookupMap<u64, Task>,
    /// Bounties (and their refunds or payouts) not yet paid out.
    escrow_held: u128,
    /// The owner's 2% share, held here until withdrawn.
    fees_accrued: u128,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// A lowercase hex SHA-256 that is not all zeroes. An all-zero hash would be a way of "committing"
/// to nothing, so it is refused wherever a hash is accepted.
fn is_valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && s.bytes().any(|b| b != b'0')
}

/// The single canonical text a rubric is hashed under. Anyone can recompute the hash from the
/// stored title and clauses: this is the whole trust property.
///
/// Control characters (so newlines) are forbidden in titles and clauses, which is what makes
/// joining them with newlines unambiguous, and the clause count is included as well.
pub fn canonical_rubric(title: &str, clauses: &[String]) -> String {
    let mut s = String::new();
    s.push_str(HASH_DOMAIN);
    s.push('\n');
    s.push_str(title);
    s.push('\n');
    s.push_str(&clauses.len().to_string());
    s.push('\n');
    for clause in clauses {
        s.push_str(clause);
        s.push('\n');
    }
    s
}

fn hash_rubric(title: &str, clauses: &[String]) -> String {
    to_hex(&env::sha256(canonical_rubric(title, clauses).as_bytes()))
}

/// A line of text: no leading or trailing space, no control characters, not empty, not too long.
/// Rejecting a stray space, instead of quietly trimming it, keeps the hash reproducible from
/// exactly what the poster sent.
fn check_line(what: &str, text: &str, max_chars: usize) {
    require!(!text.is_empty(), format!("{what} must not be empty"));
    require!(text.trim() == text, format!("{what} must not start or end with whitespace"));
    require!(
        !text.chars().any(|c| c.is_control()),
        format!("{what} must not contain control characters or line breaks")
    );
    require!(text.chars().count() <= max_chars, format!("{what} is longer than {max_chars} characters"));
}

fn validate_rubric(title: &str, clauses: &[String]) {
    check_line("the title", title, MAX_TITLE_CHARS);
    require!(!clauses.is_empty(), "a task needs at least one clause");
    require!(clauses.len() <= MAX_CLAUSES, format!("no more than {MAX_CLAUSES} clauses"));
    for (i, clause) in clauses.iter().enumerate() {
        check_line(&format!("clause {}", i + 1), clause, MAX_CLAUSE_CHARS);
    }
}

/// The fee on a bounty, rounded down. Multiply first, then divide, in checked arithmetic.
pub fn fee_for(bounty: u128) -> u128 {
    bounty
        .checked_mul(FEE_BPS)
        .expect("fee overflow")
        / BPS_DENOMINATOR
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Deploy-time setup. The caller becomes the owner.
    ///
    /// `verdict_grace_seconds` is how long after a deadline a task that a worker submitted, but
    /// the judge never ruled on, waits before the poster may reclaim it. Seven days (604800) is
    /// the production value. A short value is only for a testnet demo, and the config view shows it.
    #[init]
    pub fn new(judge_id: AccountId, max_bounty: U128, verdict_grace_seconds: u64) -> Self {
        require!(max_bounty.0 >= MIN_BOUNTY, "the bounty cap is below the minimum bounty");
        require!(max_bounty.0 <= ABSOLUTE_MAX_BOUNTY, "the bounty cap is above the hard ceiling");
        let owner_id = env::predecessor_account_id();
        require!(judge_id != owner_id, "the judge must not be the owner");
        Self {
            owner_id,
            judge_id,
            max_bounty: max_bounty.0,
            verdict_grace_ns: verdict_grace_seconds
                .checked_mul(1_000_000_000)
                .expect("grace period overflow"),
            next_task_id: 0,
            tasks: LookupMap::new(b"t".to_vec()),
            escrow_held: 0,
            fees_accrued: 0,
        }
    }

    // ----------------------------------------------------------------- the poster

    /// Seal a task: the clauses and the money lock together, and the clauses can never change.
    ///
    /// Attach `bounty` plus the storage cost. The storage cost is measured and kept by the
    /// contract; anything above `bounty` plus storage is refunded. Returns the task id.
    #[payable]
    pub fn seal(&mut self, title: String, clauses: Vec<String>, bounty: U128, deadline_ns: U64) -> U64 {
        let poster = env::predecessor_account_id();
        validate_rubric(&title, &clauses);

        let now = env::block_timestamp();
        require!(deadline_ns.0 > now, "the deadline must be in the future");
        require!(
            deadline_ns.0 <= now.checked_add(MAX_WINDOW_NS).expect("time overflow"),
            "the deadline is more than 30 days away"
        );
        require!(bounty.0 >= MIN_BOUNTY, "the bounty is below the minimum of 0.001 NEAR");
        require!(bounty.0 <= self.max_bounty, "the bounty is above the current cap");

        let id = self.next_task_id;
        self.next_task_id = id.checked_add(1).expect("task id overflow");
        let clauses_hash = hash_rubric(&title, &clauses);

        let real = Task {
            id: U64(id),
            poster: poster.clone(),
            title,
            clauses,
            clauses_hash: clauses_hash.clone(),
            bounty,
            created_ns: U64(now),
            deadline_ns,
            state: TaskState::Open,
            worker: None,
            submission_hash: None,
            submitted_ns: None,
            verdict: None,
            payout: None,
        };

        // Measure the storage this task can ever need: store it fully populated, read the cost,
        // then overwrite it with the real (smaller) value. The poster pays for the larger one, and
        // the contract keeps the difference as the reserve the later fields will grow into.
        let before = env::storage_usage();
        self.tasks.insert(id, worst_case_task(&real));
        self.tasks.flush();
        let grown = env::storage_usage().saturating_sub(before);
        self.tasks.insert(id, real);
        self.tasks.flush();

        let storage_cost = (grown as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("storage cost overflow");
        let required = bounty.0.checked_add(storage_cost).expect("deposit overflow");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= required,
            format!("attach at least {required} yoctoNEAR: the bounty plus {storage_cost} for storage")
        );

        self.escrow_held = self.escrow_held.checked_add(bounty.0).expect("escrow overflow");

        let excess = deposit - required;
        if excess > 0 {
            // Sent now, with no callback: it is the poster's own surplus, not escrow, and there is
            // nothing for the contract to record if it fails. Detached explicitly (near-sdk 5.30
            // is phasing out scheduling a promise just by dropping it).
            Promise::new(poster.clone()).transfer(NearToken::from_yoctonear(excess)).detach();
        }

        RubricEvent::Sealed {
            task_id: U64(id),
            poster,
            bounty,
            clauses_hash,
            deadline_ns,
        }
        .emit();
        U64(id)
    }

    /// The poster takes the bounty back, in full and with no fee.
    ///
    /// Two doors: an `Open` task past its deadline (nobody submitted), or a `Submitted` task past
    /// its deadline plus the grace period (a worker submitted and the judge never ruled).
    pub fn reclaim(&mut self, task_id: U64) -> Promise {
        let caller = env::predecessor_account_id();
        let mut task = self.take_task(task_id);
        require!(caller == task.poster, "only the poster can reclaim");

        let now = env::block_timestamp();
        match task.state {
            TaskState::Open => {
                require!(now > task.deadline_ns.0, "the deadline has not passed");
            }
            TaskState::Submitted => {
                let release = task
                    .deadline_ns
                    .0
                    .checked_add(self.verdict_grace_ns)
                    .expect("time overflow");
                require!(now > release, "the judge still has until the deadline plus the grace period");
            }
            TaskState::Settled | TaskState::Refunded => env::panic_str("this task is already closed"),
        }

        task.state = TaskState::Refunded;
        task.payout = Some(Payout {
            to: task.poster.clone(),
            amount: task.bounty,
            fee: U128(0),
            status: PayoutStatus::Pending,
        });
        self.tasks.insert(task_id.0, task);
        RubricEvent::Reclaimed { task_id }.emit();
        self.pay(task_id)
    }

    // ----------------------------------------------------------------- the worker

    /// Commit to a piece of work by its hash. The first valid caller owns the task.
    pub fn submit(&mut self, task_id: U64, submission_hash: String) {
        let worker = env::predecessor_account_id();
        let mut task = self.take_task(task_id);

        require!(task.state == TaskState::Open, "this task is not open for work");
        require!(worker != task.poster, "the poster cannot work their own task");
        let now = env::block_timestamp();
        require!(now <= task.deadline_ns.0, "the work window has closed");
        require!(is_valid_hash(&submission_hash), "the submission hash must be 64 lowercase hex characters and not all zero");

        task.state = TaskState::Submitted;
        task.worker = Some(worker.clone());
        task.submission_hash = Some(submission_hash.clone());
        task.submitted_ns = Some(U64(now));
        self.tasks.insert(task_id.0, task);
        RubricEvent::Submitted { task_id, worker, submission_hash }.emit();
    }

    // ----------------------------------------------------------------- the judge

    /// Record the judge's verdict and pay. Only the judge account can call this.
    ///
    /// Approve: the worker is paid the bounty less the 2% fee. Reject: the poster is refunded in
    /// full. Below `MIN_CONFIDENCE` the contract refuses to settle at all, either way.
    pub fn settle(&mut self, task_id: U64, approved: bool, confidence: u8, reasoning_hash: String) -> Promise {
        require!(env::predecessor_account_id() == self.judge_id, "only the judge can settle");
        require!(confidence <= 100, "confidence is a percentage, 0 to 100");
        require!(
            confidence >= MIN_CONFIDENCE,
            "the verdict is below the minimum confidence, so it cannot release or refund funds"
        );
        require!(is_valid_hash(&reasoning_hash), "the reasoning hash must be 64 lowercase hex characters and not all zero");

        let mut task = self.take_task(task_id);
        require!(task.state == TaskState::Submitted, "only a submitted task can be settled");

        let bounty = task.bounty.0;
        let payout = if approved {
            let fee = fee_for(bounty);
            // The fee leaves escrow and is accrued to the owner now. Only the worker's share is
            // still to be paid out.
            self.escrow_held = self.escrow_held.checked_sub(fee).expect("escrow underflow");
            self.fees_accrued = self.fees_accrued.checked_add(fee).expect("fee overflow");
            Payout {
                to: task.worker.clone().expect("a submitted task has a worker"),
                amount: U128(bounty.checked_sub(fee).expect("fee exceeds bounty")),
                fee: U128(fee),
                status: PayoutStatus::Pending,
            }
        } else {
            Payout { to: task.poster.clone(), amount: task.bounty, fee: U128(0), status: PayoutStatus::Pending }
        };

        task.state = if approved { TaskState::Settled } else { TaskState::Refunded };
        task.verdict = Some(Verdict {
            approved,
            confidence,
            reasoning_hash: reasoning_hash.clone(),
            decided_ns: U64(env::block_timestamp()),
        });
        task.payout = Some(payout);
        self.tasks.insert(task_id.0, task);

        RubricEvent::Settled { task_id, approved, confidence, reasoning_hash }.emit();
        self.pay(task_id)
    }

    // ----------------------------------------------------------------- payouts

    /// Send the payout again after a failed transfer. Anyone can call it: the recipient and the
    /// amount were fixed when the task closed, so the caller chooses nothing.
    pub fn retry_payout(&mut self, task_id: U64) -> Promise {
        let mut task = self.take_task(task_id);
        let payout = task.payout.as_mut().expect("this task has no payout");
        require!(payout.status == PayoutStatus::Failed, "the payout did not fail");
        payout.status = PayoutStatus::Pending;
        self.tasks.insert(task_id.0, task);
        self.pay(task_id)
    }

    /// Where a payout's transfer ended up. Runs as the callback of `pay`; nobody else may call it.
    #[private]
    pub fn on_payout(&mut self, task_id: U64) {
        // A transfer returns no data. Ok means it landed, Err means it failed.
        let paid = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let mut task = self.take_task(task_id);
        let payout = task.payout.as_mut().expect("a payout callback needs a payout");
        require!(payout.status == PayoutStatus::Pending, "this payout is not pending");

        let (to, amount) = (payout.to.clone(), payout.amount);
        if paid {
            payout.status = PayoutStatus::Paid;
            self.escrow_held = self.escrow_held.checked_sub(amount.0).expect("escrow underflow");
        } else {
            // The money is still here. It stays counted as escrow until `retry_payout` lands.
            payout.status = PayoutStatus::Failed;
        }
        self.tasks.insert(task_id.0, task);
        RubricEvent::PayoutResult { task_id, to, amount, paid }.emit();
    }

    // ----------------------------------------------------------------- the owner

    /// Replace the judge, for example after a key leak. Takes effect immediately.
    pub fn set_judge(&mut self, judge_id: AccountId) {
        self.assert_owner();
        require!(judge_id != self.owner_id, "the judge must not be the owner");
        let old = std::mem::replace(&mut self.judge_id, judge_id.clone());
        RubricEvent::JudgeChanged { old, new: judge_id }.emit();
    }

    /// Change the bounty cap, never above the hard ceiling. Affects new tasks only.
    pub fn set_max_bounty(&mut self, max_bounty: U128) {
        self.assert_owner();
        require!(max_bounty.0 >= MIN_BOUNTY, "the bounty cap is below the minimum bounty");
        require!(max_bounty.0 <= ABSOLUTE_MAX_BOUNTY, "the bounty cap is above the hard ceiling");
        self.max_bounty = max_bounty.0;
    }

    /// Withdraw accrued fees to the owner. The owner can reach fees and nothing else.
    pub fn withdraw_fees(&mut self, amount: Option<U128>) -> Promise {
        self.assert_owner();
        let amount = amount.map(|a| a.0).unwrap_or(self.fees_accrued);
        require!(amount > 0, "there are no fees to withdraw");
        require!(amount <= self.fees_accrued, "that is more than the accrued fees");
        self.fees_accrued -= amount;
        Promise::new(self.owner_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_fees_withdrawn(U128(amount)))
    }

    /// Put the fees back on the books if the withdrawal transfer failed.
    #[private]
    pub fn on_fees_withdrawn(&mut self, amount: U128) {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            self.fees_accrued = self.fees_accrued.checked_add(amount.0).expect("fee overflow");
        }
    }

    // ----------------------------------------------------------------- views

    pub fn get_task(&self, task_id: U64) -> Option<Task> {
        self.tasks.get(&task_id.0).cloned()
    }

    /// Tasks from `from_index`, oldest first, at most 50. Ids are sequential, so this is a plain walk.
    pub fn get_tasks(&self, from_index: U64, limit: U64) -> Vec<Task> {
        let end = from_index.0.saturating_add(limit.0.min(MAX_PAGE)).min(self.next_task_id);
        (from_index.0..end).filter_map(|id| self.tasks.get(&id).cloned()).collect()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            judge_id: self.judge_id.clone(),
            fee_bps: FEE_BPS as u16,
            min_confidence: MIN_CONFIDENCE,
            max_bounty: U128(self.max_bounty),
            verdict_grace_ns: U64(self.verdict_grace_ns),
            tasks_total: U64(self.next_task_id),
        }
    }

    pub fn get_accounting(&self) -> Accounting {
        Accounting {
            escrow_held: U128(self.escrow_held),
            fees_accrued: U128(self.fees_accrued),
            contract_balance: U128(env::account_balance().as_yoctonear()),
        }
    }

    /// The hash a rubric will be sealed under. Pure: lets a client or the judge check what the
    /// contract stored against the text, without trusting this contract's own say-so.
    pub fn compute_clauses_hash(&self, title: String, clauses: Vec<String>) -> String {
        validate_rubric(&title, &clauses);
        hash_rubric(&title, &clauses)
    }
}

// Internal helpers. Not part of the contract's public interface.
impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner can do this");
    }

    fn take_task(&self, task_id: U64) -> Task {
        self.tasks.get(&task_id.0).cloned().unwrap_or_else(|| env::panic_str("no such task"))
    }

    /// Send a task's payout, then record the outcome in `on_payout`.
    ///
    /// Callers have ALREADY updated the task's state, so a second call cannot reach this for the
    /// same task: that ordering (state first, transfer second) is what makes a double payment
    /// impossible.
    fn pay(&self, task_id: U64) -> Promise {
        let payout = self
            .tasks
            .get(&task_id.0)
            .and_then(|t| t.payout.clone())
            .expect("pay needs a payout");
        Promise::new(payout.to)
            .transfer(NearToken::from_yoctonear(payout.amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_payout(task_id))
    }
}

/// The same task with every optional field filled to its largest size. Used only to measure how
/// much storage a task can ever need, so the poster can be charged for it up front.
fn worst_case_task(task: &Task) -> Task {
    let longest_account: AccountId = "a".repeat(64).parse().expect("64 characters is a valid account id");
    let hash = "f".repeat(64);
    let mut t = task.clone();
    t.worker = Some(longest_account.clone());
    t.submission_hash = Some(hash.clone());
    t.submitted_ns = Some(U64(u64::MAX));
    t.verdict = Some(Verdict {
        approved: true,
        confidence: 100,
        reasoning_hash: hash,
        decided_ns: U64(u64::MAX),
    });
    t.payout = Some(Payout {
        to: longest_account,
        amount: U128(u128::MAX),
        fee: U128(u128::MAX),
        status: PayoutStatus::Failed,
    });
    t.state = TaskState::Refunded;
    t
}

#[cfg(test)]
mod tests;
