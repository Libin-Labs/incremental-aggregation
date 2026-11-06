import {
  createAggregator,
  type AggregateRecord,
  type GroupSummary,
} from '@lp-labs/incremental-aggregation';
const record: AggregateRecord = { id: 'a', group: 'x', value: null };
const aggregate = createAggregator();
aggregate.upsert(record);
const summary: GroupSummary | undefined = aggregate.get('x');
// @ts-expect-error aggregation does not silently parse numeric strings.
aggregate.upsert({ id: 'a', group: 'x', value: '1' });
void summary;
