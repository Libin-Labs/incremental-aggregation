# @lp-labs/incremental-aggregation

Maintain keyed, grouped numeric summaries as records are inserted, replaced, moved and deleted. Updates rebuild only affected groups rather than rescan unrelated groups.

- Zero runtime or peer dependencies; no sibling-package imports.
- ESM, CommonJS and strict TypeScript declarations.
- Count, numeric count, missing count, compensated sum, min, max and mean.
- Atomic validation/overflow rejection and transactional full rebuild.
- Framework-independent; no storage, timers, subscriptions or browser globals.

## Installation

```sh
npm install @lp-labs/incremental-aggregation
```

Requires Node.js 18+ or a modern browser with an ESM-aware bundler.

## Quickstart

```js
import { createAggregator } from '@lp-labs/incremental-aggregation';

const sales = createAggregator();
sales.upsert({ id: 'order-1', group: 'north', value: 100 });
sales.upsert({ id: 'order-2', group: 'north', value: 200 });
sales.upsert({ id: 'order-3', group: 'south', value: null });
console.log(sales.get('north').mean); // 150

sales.upsert({ id: 'order-1', group: 'south', value: 50 });
sales.delete('order-2');
console.log(sales.snapshot().map(({ group, count, sum }) => ({ group, count, sum })));
// [{ group: 'south', count: 2, sum: 50 }]
```

CommonJS: `const { createAggregator } = require('@lp-labs/incremental-aggregation')`.

## Observation model

```ts
interface AggregateRecord {
  id: string;
  group: string;
  value: number | null;
}
```

IDs and groups are nonempty strings up to 1024 UTF-16 units. They are opaque identities, not paths. Use a collision-safe encoding when group identity spans multiple fields.

Numbers must be finite JavaScript numbers. Null means missing from **numeric** statistics but still present as a record. Undefined, omitted values, numeric strings, NaN and infinity are errors. There is no implicit parsing or zero fallback.

The aggregator copies only these scalar fields and does not retain caller-owned objects. Envelope getters/proxies are not a hostile-input isolation boundary. Values need not be positive or integer, but retain ordinary JavaScript precision limits.

## API

Runtime export: `createAggregator`.

Type exports: `AggregateRecord`, `GroupSummary`, `AggregationOptions`, `Aggregator`.

### createAggregator(options?)

`maxRecords` defaults to 100000; `maxGroups` defaults to 10000. Both must be non-negative safe integers. Zero allows only empty state for the corresponding capacity.

| Method | Behavior |
|---|---|
| `upsert(record)` | Insert or replace by ID; return `'inserted'` or `'updated'`. Group changes remove the old membership and add the new one atomically. |
| `delete(id)` | Remove a known ID and recalculate its group; return false for an unknown valid ID. |
| `get(group)` | Return an independent summary, or undefined when the group has no records. |
| `snapshot()` | Return independent summaries sorted lexically by group. |
| `rebuild(records)` | Replace all state from an iterable, rejecting duplicate IDs; commit only after full validation/aggregation. |
| `size` | Readonly total retained record count, including null-valued records. |

Repeated `upsert` for one ID is replacement, not an increment. Use stable domain IDs to avoid double counting replayed changes. Deletes have no tombstones: a later upsert with the same ID inserts again. No event version, deduplication timestamp or distributed ordering protocol is inferred.

Groups with no records disappear; groups with only null values remain.

### GroupSummary

| Field | Meaning |
|---|---|
| `group` | Group identity. |
| `count` | All records, including null values. |
| `numericCount` | Finite numeric observations. |
| `missingCount` | Null observations; `count - numericCount`. |
| `sum` | Compensated sum of numeric observations, or zero. |
| `min`, `max` | Numeric extrema, or null when no numeric observations exist. |
| `mean` | Sum divided by numeric count, or null when none exist. |

## Numerical behavior and atomicity

Affected groups are recomputed from retained scalar observations using compensated summation, rather than repeatedly subtracting from a drifting total. This preserves many small residuals through cancellation, but is **not exact arithmetic** or an order-independent decimal accumulator. Membership insertion order affects floating-point evaluation. Negative zero sums normalize to zero.

An intermediate sum, correction or final sum that becomes nonfinite throws `RangeError`. A mathematically finite total can still be rejected if an intermediate addition overflows. Even deletion can fail if it removes a balancing negative/positive observation and leaves an overflowing remainder.

Validation, capacities, both sides of a group move and aggregate overflow are checked before committing an update/delete. A failed operation leaves previous state intact. `rebuild` likewise stages a full replacement; iterator errors or duplicates do not destroy previous state.

Do not use these numbers for exact financial, arbitrary-precision or safety-critical calculations. Choose an exact arithmetic representation and dedicated implementation where required.

## Rebuild verification

For external changefeed integrations, maintain an authoritative record inventory and periodically compare an independently rebuilt aggregator:

```js
import { createAggregator } from '@lp-labs/incremental-aggregation';
const records = [
  { id: 'a', group: 'one', value: 1 },
  { id: 'b', group: 'one', value: 2 },
];
const live = createAggregator();
for (const record of records) live.upsert(record);
const rebuilt = createAggregator();
rebuilt.rebuild(records);
console.log(JSON.stringify(live.snapshot()) === JSON.stringify(rebuilt.snapshot())); // true
```

Use the same membership ordering or numeric tolerances when comparing floating-point data. This package has no hidden reconciliation against a database; tests compare generated updates/deletes against full rebuilds and a separate integer-sum oracle.

## Customization and performance

Choose the numeric measure and group key in your application, then call upsert/delete from its change events. Create independent aggregators for different measures. Null should mean explicitly missing, not a suppressed validation failure.

Updates/deletes copy and recalculate affected group memberships: O(affected group size), not O(1), with temporary memory proportional to those groups. Unrelated groups are not rescanned. Full rebuild is O(records), excluding map costs; snapshots sort O(groups log groups). The complete scalar record inventory is retained, O(records + groups).

This design prioritizes predictable min/max maintenance, atomic changes and reduced cumulative subtraction drift over constant-time sums. Very large single groups or high-frequency updates may need specialized data structures; this initial release does not provide quantiles, variance, windows, approximate sketches, storage adapters or parallel workers.

Invalid records/identities/iterables and duplicate rebuild IDs throw `TypeError`; capacities and arithmetic overflow throw `RangeError`. Errors propagate without partial success or logging. Missing `get`/`delete` identities are the documented optional/false result states.

This independently authored initial release is not a database query engine or a distributed aggregation protocol.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
