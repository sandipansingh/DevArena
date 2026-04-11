# Failure Matrix And Reproduction Checklist

## Scope

- Server execution path: server/src/execution.js
- Match lifecycle path: server/src/index.js
- Client submit/feedback path: client/src/App.tsx

## Matrix

| Scenario                                  | Previous Behavior                                                                               | Expected Behavior                                                                 | Resolution                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| JS selected + Python code submitted       | Could pass local keyword validator fallback for some problems, even if code was mismatched.     | Must fail with explicit verdict and never be accepted silently.                   | Enforce language validation and output-based execution verdicts (invalid-language/compile-error/wrong-answer). |
| Accepted submission not ending room       | Room ended only on timer tick, even when accepted solution arrived and early finish is desired. | End condition must be deterministic and configurable by fairness policy.          | Add unified room outcome evaluator with timer-only and early-finish policy support.                            |
| Both submitted but no completion feedback | Room could wait for timer with no immediate deterministic close reason.                         | If both submit and no accepted result exists, finalize room with explicit reason. | Add all-submitted-no-solution end condition and battle:room-active/battle:finished lifecycle events.           |

## Reproduction Checklist

### 1) JS selected + Python code submitted

1. Start server and connect two players to a battle room.
2. Select JavaScript on client A.
3. Submit Python syntax (`def solve(input): return input`) from client A.
4. Verify verdict is invalid-language or compile-error and room remains active.
5. Verify no accepted winner is recorded from this submission.

### 2) Accepted submission not ending room

1. Start runtime with fairness policy `early-finish`.
2. Match two players and submit accepted code from one player.
3. Verify room finalizes with reason `early-accepted` without waiting for timer expiry.

### 3) Both submitted but no completion feedback

1. Match two players in active room.
2. Submit two non-accepted solutions (wrong-answer/compile-error).
3. Verify room finalizes immediately with reason `all-submitted-no-solution`.
