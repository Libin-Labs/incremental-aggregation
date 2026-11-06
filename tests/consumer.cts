import { createAggregator, type Aggregator } from '@lp-labs/incremental-aggregation';
const aggregate: Aggregator = createAggregator();
aggregate.rebuild([]);
const size: number = aggregate.size;
void size;
