# Security Spec - Splendid Tech Ticket Tracker

## Data Invariants
- `ticketNumber` is required and must be a string.
- `subject` is required and must be a string.
- `status` is required and must be one of: `Done`, `In Progress`, `Visit Scheduled`, `Open`.
- `visitDate` is optional but must be a valid date string if present.
- `userId` must match the authenticated user's UID.
- `createdAt` and `updatedAt` must match `request.time`.

## The Dirty Dozen Payloads (Rejection Targets)
1. **Identity Theft**: `create` ticket with `userId: "attacker_id"`.
2. **Schema Poisoning**: `create` ticket with `status: "invalid_status"`.
3. **Missing integrity**: `create` ticket without `ticketNumber`.
4. **Identity Spoofing**: `update` another user's ticket.
5. **Resource Exhaustion**: `create` ticket with 1MB `subject`.
6. **Immutability Breach**: `update` and change `createdAt`.
7. **Ownership Hijack**: `update` and change `userId`.
8. **ID Poisoning**: `create` ticket with `ticketId` size > 128.
9. **Temporal Fraud**: `create` ticket with client-provided `createdAt` != `request.time`.
10. **State Corruption**: `update` ticket with invalid `status`.
11. **Unauthorized Access**: `list` all tickets without `userId` filter.
12. **Unauthorized Deletion**: `delete` another user's ticket.

## Test Runner (Logic Check)
The `firestore.rules` will be verified against these payloads using the rules engine primitives.
