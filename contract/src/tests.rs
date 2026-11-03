//! Unit tests for the Rubric escrow contract.
//!
//! Each refusal is asserted with the message it must fail with, not just "it failed": a test
//! that passes because the call panicked for some unrelated reason proves nothing.

use super::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
use sha2::{Digest, Sha256};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SECOND: u64 = 1_000_000_000;
const DAY: u64 = 24 * 60 * 60 * SECOND;
const T0: u64 = 1_800_000_000 * SECOND;

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}
fn contract_id() -> AccountId {
    acct("rubric.testnet")
}
fn owner() -> AccountId {
    acct("owner.testnet")
}
fn judge() -> AccountId {
    acct("judge.testnet")
}
fn poster() -> AccountId {
    acct("poster.testnet")
}
fn worker() -> AccountId {
    acct("worker.testnet")
}
fn stranger() -> AccountId {
    acct("stranger.testnet")
}

fn context(predecessor: AccountId, deposit: u128, now_ns: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ns)
        .account_balance(NearToken::from_near(1_000));
    b
}

fn at(predecessor: AccountId, deposit: u128, now_ns: u64) {
    testing_env!(context(predecessor, deposit, now_ns).build());
}

fn deploy() -> Contract {
    at(owner(), 0, T0);
    Contract::new(owner(), judge(), U128(10 * NEAR), 7 * 24 * 60 * 60)
}

const HASH_A: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH_B: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

fn seal_default(c: &mut Contract, now: u64) -> U64 {
    at(poster(), 2 * NEAR, now);
    c.seal(
        "Fix the docs".into(),
        vec!["The submission lists numbered steps.".into(), "It quotes the exact error text.".into()],
        U128(NEAR),
        U64(now + DAY),
    )
}

fn submit_default(c: &mut Contract, id: U64, now: u64) {
    at(worker(), 0, now);
    c.submit(id, HASH_A.into());
}

fn settle_as_judge(c: &mut Contract, id: U64, approved: bool, confidence: u8, now: u64) -> Promise {
    at(judge(), 0, now);
    c.settle(id, approved, confidence, HASH_B.into())
}

/// The transfers scheduled so far in this call: (receiver, yoctoNEAR).
fn transfers() -> Vec<(AccountId, u128)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in &receipt.actions {
            if let near_sdk::mock::MockAction::Transfer { deposit, .. } = action {
                out.push((receipt.receiver_id.clone(), deposit.as_yoctonear()));
            }
        }
    }
    out
}

/// Run `f` and return the message of the panic it raises, or fail if it does not panic.
fn panic_message<F: FnOnce() + std::panic::UnwindSafe>(f: F) -> String {
    let err = std::panic::catch_unwind(f).expect_err("expected a panic, but the call succeeded");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn expect_panic<F: FnOnce() + std::panic::UnwindSafe>(f: F, needle: &str) {
    let msg = panic_message(f);
    assert!(msg.contains(needle), "expected a panic containing {needle:?}, got {msg:?}");
}

/// Deliver the result of the payout transfer to `on_payout`, as the runtime would.
fn deliver_payout_result(c: &mut Contract, id: U64, ok: bool, now: u64) {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        context(contract_id(), 0, now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    c.on_payout(id);
}

// ---------------------------------------------------------------------------
// The hash: the whole trust property
// ---------------------------------------------------------------------------

#[test]
fn golden_hash_vectors_match_an_independent_implementation() {
    at(owner(), 0, T0);
    // Computed with Node's crypto in a separate step; the judge service must reproduce these.
    let cases: [(&str, Vec<&str>, &str); 3] = [
        (
            "Fix the docs",
            vec!["The submission lists numbered steps.", "It quotes the exact error text."],
            "85274b4ea772c3a3e6a2da1e3acd995415bff05aa71a8dd0b323504aaba2c018",
        ),
        ("T", vec!["One."], "fb51a0041d64a5a16f5eeb266df22782f7e8d75b7306d3940335b4d2861f6e84"),
        (
            "Unicode ok",
            vec!["Caf\u{e9} \u{2014} r\u{e9}sum\u{e9} stays as written."],
            "d4922f425accc8f14837adb7e9e6b0a1936292bdfa1a93f4163bfa309807c735",
        ),
    ];
    for (title, clauses, expected) in cases {
        let clauses: Vec<String> = clauses.into_iter().map(String::from).collect();
        assert_eq!(hash_rubric(title, &clauses), expected, "{title}");
    }
}

#[test]
fn the_on_chain_hash_equals_sha2_over_the_canonical_text() {
    at(owner(), 0, T0);
    let clauses = vec!["First.".to_string(), "Second.".to_string()];
    let expected = to_hex(&Sha256::digest(canonical_rubric("Title", &clauses).as_bytes()));
    assert_eq!(hash_rubric("Title", &clauses), expected);
}

#[test]
fn canonical_form_is_unambiguous() {
    at(owner(), 0, T0);
    // Moving text between clauses, or merging two clauses, changes the hash.
    let a = hash_rubric("T", &["ab".to_string(), "c".to_string()]);
    let b = hash_rubric("T", &["a".to_string(), "bc".to_string()]);
    let c = hash_rubric("T", &["abc".to_string()]);
    assert_ne!(a, b);
    assert_ne!(a, c);
    assert_ne!(b, c);
    // And the title is part of it.
    assert_ne!(hash_rubric("T", &["abc".to_string()]), hash_rubric("U", &["abc".to_string()]));
}

#[test]
fn seal_stores_the_hash_it_computed_not_one_it_was_given() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    let task = c.get_task(id).unwrap();
    assert_eq!(task.clauses_hash, "85274b4ea772c3a3e6a2da1e3acd995415bff05aa71a8dd0b323504aaba2c018");
    assert_eq!(task.clauses_hash, c.compute_clauses_hash(task.title.clone(), task.clauses.clone()));
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

#[test]
fn seal_creates_an_open_task_and_escrows_the_bounty() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    assert_eq!(id.0, 0);
    let task = c.get_task(id).unwrap();
    assert_eq!(task.state, TaskState::Open);
    assert_eq!(task.poster, poster());
    assert_eq!(task.bounty.0, NEAR);
    assert_eq!(task.clauses.len(), 2);
    assert!(task.worker.is_none() && task.verdict.is_none() && task.payout.is_none());
    assert_eq!(c.get_accounting().escrow_held.0, NEAR);
}

#[test]
fn ids_are_sequential() {
    let mut c = deploy();
    assert_eq!(seal_default(&mut c, T0).0, 0);
    assert_eq!(seal_default(&mut c, T0).0, 1);
    assert_eq!(c.get_config().tasks_total.0, 2);
}

#[test]
fn seal_refunds_what_was_attached_beyond_bounty_and_storage() {
    let mut c = deploy();
    seal_default(&mut c, T0);
    // The poster attached 2 NEAR for a 1 NEAR bounty, so most of the rest comes back.
    let refunds = transfers();
    assert_eq!(refunds.len(), 1, "exactly one refund transfer: {refunds:?}");
    assert_eq!(refunds[0].0, poster());
    assert!(refunds[0].1 > NEAR / 2 && refunds[0].1 < NEAR, "refund was {}", refunds[0].1);
}

#[test]
fn seal_charges_for_storage_so_an_exact_bounty_deposit_is_refused() {
    let mut c = deploy();
    at(poster(), NEAR, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.seal("Fix the docs".into(), vec!["One clause.".into()], U128(NEAR), U64(T0 + DAY));
        }),
        "for storage",
    );
}

#[test]
fn a_failed_seal_leaves_nothing_behind() {
    let mut c = deploy();
    at(poster(), NEAR, T0);
    let _ = panic_message(std::panic::AssertUnwindSafe(|| {
        c.seal("Fix the docs".into(), vec!["One clause.".into()], U128(NEAR), U64(T0 + DAY));
    }));
    // The panic reverts in a real run; in a unit test the in-memory struct survives, so check
    // that the next id was not burned in a way that matters to a caller: a fresh seal still works.
    let id = seal_default(&mut c, T0);
    assert!(c.get_task(id).is_some());
}

#[test]
fn seal_rejects_a_bad_rubric() {
    let mut c = deploy();
    let long_clause = "x".repeat(MAX_CLAUSE_CHARS + 1);
    let nine: Vec<String> = (0..9).map(|i| format!("Clause {i}.")).collect();
    let cases: Vec<(&str, Vec<String>, &str)> = vec![
        ("", vec!["ok".into()], "the title must not be empty"),
        (" padded", vec!["ok".into()], "the title must not start or end with whitespace"),
        ("Title", vec![], "at least one clause"),
        ("Title", nine, "no more than 8 clauses"),
        ("Title", vec!["".into()], "clause 1 must not be empty"),
        ("Title", vec!["ok".into(), long_clause], "clause 2 is longer than 280 characters"),
        ("Title", vec!["trailing ".into()], "clause 1 must not start or end with whitespace"),
        ("Title", vec!["two\nlines".into()], "clause 1 must not contain control characters"),
        ("Title", vec!["tab\there".into()], "clause 1 must not contain control characters"),
    ];
    for (title, clauses, needle) in cases {
        at(poster(), 2 * NEAR, T0);
        let t = title.to_string();
        expect_panic(
            std::panic::AssertUnwindSafe(|| {
                c.seal(t, clauses, U128(NEAR), U64(T0 + DAY));
            }),
            needle,
        );
    }
}

#[test]
fn clause_and_title_limits_count_characters_not_bytes() {
    let mut c = deploy();
    // 280 two-byte characters is 560 bytes but exactly 280 characters, so it is allowed.
    at(poster(), 2 * NEAR, T0);
    let clause = "\u{e9}".repeat(MAX_CLAUSE_CHARS);
    let id = c.seal("T".into(), vec![clause], U128(NEAR), U64(T0 + DAY));
    assert_eq!(c.get_task(id).unwrap().clauses[0].chars().count(), MAX_CLAUSE_CHARS);
}

#[test]
fn seal_enforces_the_deadline_window() {
    let mut c = deploy();
    for (deadline, needle) in [
        (T0, "the deadline must be in the future"),
        (T0 - SECOND, "the deadline must be in the future"),
        (T0 + 31 * DAY, "more than 30 days away"),
    ] {
        at(poster(), 2 * NEAR, T0);
        expect_panic(
            std::panic::AssertUnwindSafe(|| {
                c.seal("T".into(), vec!["One.".into()], U128(NEAR), U64(deadline));
            }),
            needle,
        );
    }
    // Exactly 30 days is allowed.
    at(poster(), 2 * NEAR, T0);
    c.seal("T".into(), vec!["One.".into()], U128(NEAR), U64(T0 + 30 * DAY));
}

#[test]
fn seal_enforces_the_bounty_bounds() {
    let mut c = deploy();
    for (bounty, needle) in [
        (0, "below the minimum"),
        (MIN_BOUNTY - 1, "below the minimum"),
        (10 * NEAR + 1, "above the current cap"),
    ] {
        at(poster(), 20 * NEAR, T0);
        expect_panic(
            std::panic::AssertUnwindSafe(|| {
                c.seal("T".into(), vec!["One.".into()], U128(bounty), U64(T0 + DAY));
            }),
            needle,
        );
    }
    // The cap itself is allowed.
    at(poster(), 20 * NEAR, T0);
    c.seal("T".into(), vec!["One.".into()], U128(10 * NEAR), U64(T0 + DAY));
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

#[test]
fn submit_moves_an_open_task_to_submitted() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let task = c.get_task(id).unwrap();
    assert_eq!(task.state, TaskState::Submitted);
    assert_eq!(task.worker, Some(worker()));
    assert_eq!(task.submission_hash.as_deref(), Some(HASH_A));
    assert_eq!(task.submitted_ns.unwrap().0, T0 + 1000);
}

#[test]
fn the_poster_cannot_work_their_own_task() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    at(poster(), 0, T0 + 1000);
    expect_panic(std::panic::AssertUnwindSafe(|| c.submit(id, HASH_A.into())), "cannot work their own task");
}

#[test]
fn only_the_first_submission_wins() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    at(stranger(), 0, T0 + 2000);
    expect_panic(std::panic::AssertUnwindSafe(|| c.submit(id, HASH_B.into())), "not open for work");
    assert_eq!(c.get_task(id).unwrap().worker, Some(worker()));
}

#[test]
fn submit_is_refused_after_the_deadline() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    at(worker(), 0, T0 + DAY + 1);
    expect_panic(std::panic::AssertUnwindSafe(|| c.submit(id, HASH_A.into())), "work window has closed");
    // The deadline itself is still inside the window.
    at(worker(), 0, T0 + DAY);
    c.submit(id, HASH_A.into());
}

#[test]
fn submit_rejects_malformed_and_empty_hashes() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    for bad in [
        "",
        "abc",
        &"0".repeat(64),
        &"A".repeat(64),
        &"g".repeat(64),
        &format!("{}0", HASH_A),
    ] {
        at(worker(), 0, T0 + 1000);
        expect_panic(std::panic::AssertUnwindSafe(|| c.submit(id, bad.to_string())), "64 lowercase hex");
    }
}

#[test]
fn submit_on_a_missing_task_fails() {
    let mut c = deploy();
    at(worker(), 0, T0);
    expect_panic(std::panic::AssertUnwindSafe(|| c.submit(U64(99), HASH_A.into())), "no such task");
}

// ---------------------------------------------------------------------------
// Settling: the money
// ---------------------------------------------------------------------------

#[test]
fn approve_pays_the_worker_the_bounty_less_two_percent_and_accrues_the_fee() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);

    let task = c.get_task(id).unwrap();
    assert_eq!(task.state, TaskState::Settled);
    let payout = task.payout.unwrap();
    assert_eq!(payout.to, worker());
    assert_eq!(payout.fee.0, NEAR / 50, "2% of 1 NEAR");
    assert_eq!(payout.amount.0, NEAR - NEAR / 50, "98% of 1 NEAR");
    assert_eq!(payout.status, PayoutStatus::Pending);

    let verdict = task.verdict.unwrap();
    assert!(verdict.approved);
    assert_eq!(verdict.confidence, 95);
    assert_eq!(verdict.reasoning_hash, HASH_B);

    // The transfer to the worker is the only transfer; the fee stays in the contract.
    let sent = transfers();
    assert_eq!(sent, vec![(worker(), NEAR - NEAR / 50)]);
    let acc = c.get_accounting();
    assert_eq!(acc.fees_accrued.0, NEAR / 50);
    assert_eq!(acc.escrow_held.0, NEAR - NEAR / 50, "only the worker's share is still escrowed");
}

#[test]
fn reject_refunds_the_poster_in_full_with_no_fee() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, false, 90, T0 + 2000);

    let task = c.get_task(id).unwrap();
    assert_eq!(task.state, TaskState::Refunded);
    let payout = task.payout.unwrap();
    assert_eq!(payout.to, poster());
    assert_eq!(payout.amount.0, NEAR);
    assert_eq!(payout.fee.0, 0);
    assert!(!task.verdict.unwrap().approved);
    assert_eq!(transfers(), vec![(poster(), NEAR)]);
    assert_eq!(c.get_accounting().fees_accrued.0, 0);
}

#[test]
fn fee_arithmetic_rounds_down_and_never_exceeds_the_bounty() {
    assert_eq!(fee_for(0), 0);
    assert_eq!(fee_for(49), 0, "below 50 yocto the 2% rounds to nothing");
    assert_eq!(fee_for(50), 1);
    assert_eq!(fee_for(10_000), 200);
    assert_eq!(fee_for(MIN_BOUNTY), MIN_BOUNTY / 50);
    // Checked on the largest bounty the contract can hold.
    assert_eq!(fee_for(ABSOLUTE_MAX_BOUNTY), ABSOLUTE_MAX_BOUNTY / 50);
    for b in [1u128, 99, 12_345, NEAR, 7 * NEAR + 13, ABSOLUTE_MAX_BOUNTY] {
        assert!(fee_for(b) <= b / 50 + 1 && fee_for(b) < b);
    }
}

#[test]
fn only_the_judge_can_settle() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    for who in [owner(), poster(), worker(), stranger()] {
        at(who, 0, T0 + 2000);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.settle(id, true, 95, HASH_B.into());
        }), "only the judge");
    }
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Submitted);
}

#[test]
fn the_judge_cannot_settle_below_the_minimum_confidence_either_way() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    for approved in [true, false] {
        for confidence in [0u8, 1, 50, MIN_CONFIDENCE - 1] {
            at(judge(), 0, T0 + 2000);
            expect_panic(std::panic::AssertUnwindSafe(|| {
                let _ = c.settle(id, approved, confidence, HASH_B.into());
            }), "below the minimum confidence");
        }
    }
    // The threshold itself is accepted.
    let _ = settle_as_judge(&mut c, id, true, MIN_CONFIDENCE, T0 + 2000);
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Settled);
}

#[test]
fn confidence_above_one_hundred_is_rejected() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    at(judge(), 0, T0 + 2000);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(id, true, 101, HASH_B.into());
    }), "0 to 100");
}

#[test]
fn settle_rejects_a_bad_reasoning_hash() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    for bad in ["", "nope", &"0".repeat(64)] {
        at(judge(), 0, T0 + 2000);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.settle(id, true, 95, bad.to_string());
        }), "reasoning hash");
    }
}

#[test]
fn only_a_submitted_task_can_be_settled() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    at(judge(), 0, T0 + 1000);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(id, true, 95, HASH_B.into());
    }), "only a submitted task");
    at(judge(), 0, T0 + 1000);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(U64(42), true, 95, HASH_B.into());
    }), "no such task");
}

#[test]
fn a_verdict_cannot_be_replayed_or_overridden() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);
    // The same verdict again, and the opposite one, both bounce.
    for approved in [true, false] {
        at(judge(), 0, T0 + 3000);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.settle(id, approved, 95, HASH_B.into());
        }), "only a submitted task");
    }
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Settled);
}

// ---------------------------------------------------------------------------
// Reclaiming
// ---------------------------------------------------------------------------

#[test]
fn an_open_task_can_be_reclaimed_only_after_its_deadline() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    at(poster(), 0, T0 + DAY);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.reclaim(id);
    }), "deadline has not passed");

    at(poster(), 0, T0 + DAY + 1);
    let _ = c.reclaim(id);
    let task = c.get_task(id).unwrap();
    assert_eq!(task.state, TaskState::Refunded);
    assert!(task.verdict.is_none(), "a reclaim records no verdict");
    assert_eq!(transfers(), vec![(poster(), NEAR)], "refunded in full, no fee");
}

#[test]
fn only_the_poster_can_reclaim() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    for who in [owner(), judge(), worker(), stranger()] {
        at(who, 0, T0 + 2 * DAY);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.reclaim(id);
        }), "only the poster");
    }
}

#[test]
fn a_submitted_task_waits_out_the_grace_period_before_it_can_be_reclaimed() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let release = T0 + DAY + 7 * DAY;

    // Past the deadline but inside the grace: the judge still has time.
    at(poster(), 0, T0 + DAY + 1);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.reclaim(id);
    }), "grace period");
    at(poster(), 0, release);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.reclaim(id);
    }), "grace period");

    at(poster(), 0, release + 1);
    let _ = c.reclaim(id);
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Refunded);
}

#[test]
fn the_judge_can_still_rule_after_the_deadline_until_the_poster_reclaims() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 3 * DAY);
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Settled);
}

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

#[test]
fn settled_and_refunded_tasks_cannot_be_moved_by_any_function() {
    for approved in [true, false] {
        let mut c = deploy();
        let id = seal_default(&mut c, T0);
        submit_default(&mut c, id, T0 + 1000);
        let _ = settle_as_judge(&mut c, id, approved, 95, T0 + 2000);
        let closed = c.get_task(id).unwrap().state;
        assert!(matches!(closed, TaskState::Settled | TaskState::Refunded));

        let late = T0 + 30 * DAY;
        at(worker(), 0, T0 + 2500);
        expect_panic(std::panic::AssertUnwindSafe(|| c.submit(id, HASH_B.into())), "not open for work");
        at(judge(), 0, late);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.settle(id, !approved, 95, HASH_B.into());
        }), "only a submitted task");
        at(poster(), 0, late);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.reclaim(id);
        }), "already closed");
        assert_eq!(c.get_task(id).unwrap().state, closed);
    }
}

// ---------------------------------------------------------------------------
// Payout outcomes
// ---------------------------------------------------------------------------

#[test]
fn a_successful_payout_is_recorded_and_leaves_escrow() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);

    deliver_payout_result(&mut c, id, true, T0 + 3000);
    assert_eq!(c.get_task(id).unwrap().payout.unwrap().status, PayoutStatus::Paid);
    assert_eq!(c.get_accounting().escrow_held.0, 0, "everything has been paid out of escrow");
    assert_eq!(c.get_accounting().fees_accrued.0, NEAR / 50);
}

#[test]
fn a_failed_payout_keeps_the_money_counted_and_can_be_retried() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);

    deliver_payout_result(&mut c, id, false, T0 + 3000);
    let payout = c.get_task(id).unwrap().payout.unwrap();
    assert_eq!(payout.status, PayoutStatus::Failed);
    assert_eq!(c.get_accounting().escrow_held.0, payout.amount.0, "the unpaid money is still escrowed");
    // The task is still terminal.
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Settled);

    // Anyone can retry; the recipient and amount are fixed.
    at(stranger(), 0, T0 + 4000);
    let _ = c.retry_payout(id);
    assert_eq!(transfers(), vec![(worker(), NEAR - NEAR / 50)]);
    assert_eq!(c.get_task(id).unwrap().payout.unwrap().status, PayoutStatus::Pending);

    deliver_payout_result(&mut c, id, true, T0 + 5000);
    assert_eq!(c.get_task(id).unwrap().payout.unwrap().status, PayoutStatus::Paid);
    assert_eq!(c.get_accounting().escrow_held.0, 0);
}

#[test]
fn a_payout_cannot_be_retried_unless_it_failed() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);

    // Pending, then Paid: neither can be retried, so a payout can never be sent twice.
    at(stranger(), 0, T0 + 2500);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.retry_payout(id);
    }), "did not fail");
    deliver_payout_result(&mut c, id, true, T0 + 3000);
    at(stranger(), 0, T0 + 3500);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.retry_payout(id);
    }), "did not fail");
}

// NOT TESTED HERE: that `on_payout` and `on_fees_withdrawn` refuse every caller but the contract
// itself. `#[private]` is enforced in the contract's exported entry point, not in the Rust method,
// so a unit test that calls the method directly would skip the guard and prove nothing. It is
// tested through the real runtime in `tests/integration.rs` (sandbox), where a stranger calls the
// callback and must be refused.

#[test]
fn a_refund_payout_failure_is_recorded_the_same_way() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    at(poster(), 0, T0 + DAY + 1);
    let _ = c.reclaim(id);
    deliver_payout_result(&mut c, id, false, T0 + DAY + 2);
    assert_eq!(c.get_task(id).unwrap().payout.unwrap().status, PayoutStatus::Failed);
    assert_eq!(c.get_accounting().escrow_held.0, NEAR);
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

#[test]
fn owner_functions_refuse_everyone_else() {
    let mut c = deploy();
    for who in [judge(), poster(), worker(), stranger()] {
        at(who.clone(), 0, T0);
        expect_panic(std::panic::AssertUnwindSafe(|| c.set_judge(acct("new.testnet"))), "only the owner");
        at(who.clone(), 0, T0);
        expect_panic(std::panic::AssertUnwindSafe(|| c.set_max_bounty(U128(NEAR))), "only the owner");
        at(who, 0, T0);
        expect_panic(std::panic::AssertUnwindSafe(|| {
            let _ = c.withdraw_fees(None);
        }), "only the owner");
    }
}

#[test]
fn rotating_the_judge_takes_effect_immediately() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);

    at(owner(), 0, T0 + 1500);
    c.set_judge(acct("judge2.testnet"));
    assert_eq!(c.get_config().judge_id, acct("judge2.testnet"));

    // The old judge is now refused, and the new one accepted.
    at(judge(), 0, T0 + 2000);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(id, true, 95, HASH_B.into());
    }), "only the judge");
    at(acct("judge2.testnet"), 0, T0 + 2000);
    let _ = c.settle(id, true, 95, HASH_B.into());
    assert_eq!(c.get_task(id).unwrap().state, TaskState::Settled);
}

#[test]
fn the_owner_cannot_make_themselves_the_judge() {
    let mut c = deploy();
    at(owner(), 0, T0);
    expect_panic(std::panic::AssertUnwindSafe(|| c.set_judge(owner())), "must not be the owner");
    at(owner(), 0, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            let _ = Contract::new(owner(), owner(), U128(NEAR), 60);
        }),
        "must not be the owner",
    );
}

#[test]
fn the_owner_is_the_account_named_at_init_not_whoever_sends_the_call() {
    // Deploy and init are signed by the contract's own account. The owner must still be the one
    // that was named, and nobody else.
    at(contract_id(), 0, T0);
    let c = Contract::new(owner(), judge(), U128(10 * NEAR), 60);
    assert_eq!(c.get_config().owner_id, owner());
    assert_ne!(c.get_config().owner_id, contract_id());
}

#[test]
fn the_bounty_cap_is_bounded_by_the_hard_ceiling() {
    let mut c = deploy();
    at(owner(), 0, T0);
    c.set_max_bounty(U128(ABSOLUTE_MAX_BOUNTY));
    at(owner(), 0, T0);
    expect_panic(std::panic::AssertUnwindSafe(|| c.set_max_bounty(U128(ABSOLUTE_MAX_BOUNTY + 1))), "hard ceiling");
    at(owner(), 0, T0);
    expect_panic(std::panic::AssertUnwindSafe(|| c.set_max_bounty(U128(MIN_BOUNTY - 1))), "below the minimum");
    at(owner(), 0, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            let _ = Contract::new(owner(), judge(), U128(ABSOLUTE_MAX_BOUNTY + 1), 60);
        }),
        "hard ceiling",
    );
}

#[test]
fn lowering_the_cap_does_not_touch_existing_tasks() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    at(owner(), 0, T0);
    c.set_max_bounty(U128(MIN_BOUNTY));
    assert_eq!(c.get_task(id).unwrap().bounty.0, NEAR);
    at(poster(), 2 * NEAR, T0);
    expect_panic(
        std::panic::AssertUnwindSafe(|| {
            c.seal("T".into(), vec!["One.".into()], U128(NEAR), U64(T0 + DAY));
        }),
        "above the current cap",
    );
}

#[test]
fn the_owner_can_withdraw_exactly_the_accrued_fees_and_nothing_else() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);
    let fee = NEAR / 50;

    at(owner(), 0, T0 + 3000);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.withdraw_fees(Some(U128(fee + 1)));
    }), "more than the accrued fees");

    at(owner(), 0, T0 + 3000);
    let _ = c.withdraw_fees(Some(U128(fee / 2)));
    assert_eq!(c.get_accounting().fees_accrued.0, fee - fee / 2);
    assert_eq!(transfers(), vec![(owner(), fee / 2)]);

    at(owner(), 0, T0 + 3000);
    let _ = c.withdraw_fees(None);
    assert_eq!(c.get_accounting().fees_accrued.0, 0);

    at(owner(), 0, T0 + 3000);
    expect_panic(std::panic::AssertUnwindSafe(|| {
        let _ = c.withdraw_fees(None);
    }), "no fees to withdraw");
    // Escrow is untouched by all of it.
    assert_eq!(c.get_accounting().escrow_held.0, NEAR - fee);
}

#[test]
fn a_failed_fee_withdrawal_puts_the_fees_back() {
    let mut c = deploy();
    let id = seal_default(&mut c, T0);
    submit_default(&mut c, id, T0 + 1000);
    let _ = settle_as_judge(&mut c, id, true, 95, T0 + 2000);
    let fee = NEAR / 50;
    at(owner(), 0, T0 + 3000);
    let _ = c.withdraw_fees(None);
    assert_eq!(c.get_accounting().fees_accrued.0, 0);

    testing_env!(
        context(contract_id(), 0, T0 + 4000).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    c.on_fees_withdrawn(U128(fee));
    assert_eq!(c.get_accounting().fees_accrued.0, fee);
}

// ---------------------------------------------------------------------------
// Views and accounting
// ---------------------------------------------------------------------------

#[test]
fn get_tasks_pages_through_tasks_in_order_and_caps_the_page() {
    let mut c = deploy();
    for _ in 0..5 {
        seal_default(&mut c, T0);
    }
    let ids = |v: Vec<Task>| v.into_iter().map(|t| t.id.0).collect::<Vec<_>>();
    assert_eq!(ids(c.get_tasks(U64(0), U64(3))), vec![0, 1, 2]);
    assert_eq!(ids(c.get_tasks(U64(3), U64(10))), vec![3, 4]);
    assert_eq!(ids(c.get_tasks(U64(9), U64(10))), Vec::<u64>::new());
    assert_eq!(c.get_tasks(U64(0), U64(1_000_000)).len(), 5);
}

#[test]
fn get_task_on_a_missing_id_is_none() {
    let c = deploy();
    assert!(c.get_task(U64(0)).is_none());
}

#[test]
fn config_reports_the_fixed_rules() {
    let c = deploy();
    let cfg = c.get_config();
    assert_eq!(cfg.fee_bps, 200);
    assert_eq!(cfg.min_confidence, 70);
    assert_eq!(cfg.judge_id, judge());
    assert_eq!(cfg.owner_id, owner());
    assert_eq!(cfg.verdict_grace_ns.0, 7 * DAY);
}

#[test]
fn escrow_plus_fees_always_equals_what_was_sealed_less_what_was_paid() {
    let mut c = deploy();
    let a = seal_default(&mut c, T0);
    let b = seal_default(&mut c, T0);
    let d = seal_default(&mut c, T0);
    let sealed = 3 * NEAR;
    assert_eq!(c.get_accounting().escrow_held.0, sealed);

    // a: approved and paid. b: rejected and paid. d: left open.
    for (id, approved) in [(a, true), (b, false)] {
        submit_default(&mut c, id, T0 + 1000);
        let _ = settle_as_judge(&mut c, id, approved, 95, T0 + 2000);
        deliver_payout_result(&mut c, id, true, T0 + 3000);
    }
    let acc = c.get_accounting();
    let paid_to_worker = NEAR - NEAR / 50;
    let refunded = NEAR;
    // The fee is part of the bounty, not on top of it: what is held, owed as fees and already paid
    // out adds up to exactly what was sealed, with nothing created and nothing lost.
    assert_eq!(acc.escrow_held.0 + acc.fees_accrued.0 + paid_to_worker + refunded, sealed);
    assert_eq!(acc.escrow_held.0, NEAR, "only the open task d is still escrowed");
    assert_eq!(c.get_task(d).unwrap().state, TaskState::Open);
}
