export interface AggregateRecord {
  id: string;
  group: string;
  value: number | null;
}
export interface GroupSummary {
  group: string;
  count: number;
  numericCount: number;
  missingCount: number;
  sum: number;
  min: number | null;
  max: number | null;
  mean: number | null;
}
export interface AggregationOptions {
  maxRecords?: number;
  maxGroups?: number;
}
export interface Aggregator {
  upsert(record: AggregateRecord): 'inserted' | 'updated';
  delete(id: string): boolean;
  get(group: string): GroupSummary | undefined;
  snapshot(): GroupSummary[];
  rebuild(records: Iterable<AggregateRecord>): void;
  readonly size: number;
}
function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  return value;
}
function identity(value: string): void {
  if (typeof value !== 'string' || value.length > 1024 || value.length === 0)
    throw new TypeError('IDs/groups must be nonempty strings up to 1024 units.');
}
function copy(input: AggregateRecord): AggregateRecord {
  identity(input.id);
  identity(input.group);
  if (input.value !== null && (typeof input.value !== 'number' || !Number.isFinite(input.value)))
    throw new TypeError('value must be a finite number or null.');
  return { id: input.id, group: input.group, value: input.value };
}
function summarize(group: string, records: Iterable<AggregateRecord>): GroupSummary {
  let count = 0,
    numericCount = 0,
    sum = 0,
    correction = 0;
  let minimum: number | null = null,
    maximum: number | null = null;
  for (const record of records) {
    count++;
    const value = record.value;
    if (value === null) continue;
    numericCount++;
    const next = sum + value;
    if (!Number.isFinite(next)) throw new RangeError('Intermediate aggregate sum overflow.');
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    if (!Number.isFinite(correction)) throw new RangeError('Aggregate correction overflow.');
    sum = next;
    minimum = minimum === null ? value : Math.min(minimum, value);
    maximum = maximum === null ? value : Math.max(maximum, value);
  }
  sum += correction;
  if (!Number.isFinite(sum)) throw new RangeError('Aggregate sum overflow.');
  return {
    group,
    count,
    numericCount,
    missingCount: count - numericCount,
    sum: sum === 0 ? 0 : sum,
    min: minimum,
    max: maximum,
    mean: numericCount === 0 ? null : sum / numericCount,
  };
}
interface Group {
  members: Map<string, AggregateRecord>;
  summary: GroupSummary;
}
export function createAggregator(options: AggregationOptions = {}): Aggregator {
  const maxRecords = integer(options.maxRecords ?? 100_000, 'maxRecords');
  const maxGroups = integer(options.maxGroups ?? 10_000, 'maxGroups');
  let records = new Map<string, AggregateRecord>();
  let groups = new Map<string, Group>();
  const setGroup = (key: string, members: Map<string, AggregateRecord>, summary: GroupSummary) => {
    if (members.size) groups.set(key, { members, summary });
    else groups.delete(key);
  };
  return {
    get size() {
      return records.size;
    },
    upsert(input) {
      const next = copy(input);
      const previous = records.get(next.id);
      if (!previous && records.size === maxRecords)
        throw new RangeError('Aggregation exceeds maxRecords.');
      const oldGroup = previous ? groups.get(previous.group)! : undefined;
      const remainingGroupCount =
        groups.size -
        (previous && previous.group !== next.group && oldGroup!.members.size === 1 ? 1 : 0);
      if (!groups.has(next.group) && remainingGroupCount === maxGroups)
        throw new RangeError('Aggregation exceeds maxGroups.');
      const nextMembers = new Map(groups.get(next.group)?.members);
      nextMembers.set(next.id, next);
      const nextSummary = summarize(next.group, nextMembers.values());
      let oldMembers: Map<string, AggregateRecord> | undefined;
      let oldSummary: GroupSummary | undefined;
      if (previous && previous.group !== next.group) {
        oldMembers = new Map(oldGroup!.members);
        oldMembers.delete(next.id);
        oldSummary = summarize(previous.group, oldMembers.values());
      }
      if (previous && oldMembers && oldSummary) setGroup(previous.group, oldMembers, oldSummary);
      setGroup(next.group, nextMembers, nextSummary);
      records.set(next.id, next);
      return previous ? 'updated' : 'inserted';
    },
    delete(id) {
      identity(id);
      const previous = records.get(id);
      if (!previous) return false;
      const members = new Map(groups.get(previous.group)!.members);
      members.delete(id);
      const summary = summarize(previous.group, members.values());
      records.delete(id);
      setGroup(previous.group, members, summary);
      return true;
    },
    get(group) {
      identity(group);
      const summary = groups.get(group)?.summary;
      return summary ? { ...summary } : undefined;
    },
    snapshot() {
      return [...groups.values()]
        .map(({ summary }) => ({ ...summary }))
        .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
    },
    rebuild(input) {
      if (input == null || typeof input[Symbol.iterator] !== 'function')
        throw new TypeError('Records must be iterable.');
      const nextRecords = new Map<string, AggregateRecord>();
      const nextGroups = new Map<string, Group>();
      for (const value of input) {
        if (nextRecords.size === maxRecords)
          throw new RangeError('Aggregation exceeds maxRecords.');
        const record = copy(value);
        if (nextRecords.has(record.id)) throw new TypeError(`Duplicate record id: ${record.id}`);
        nextRecords.set(record.id, record);
        let group = nextGroups.get(record.group);
        if (!group) {
          if (nextGroups.size === maxGroups) throw new RangeError('Aggregation exceeds maxGroups.');
          group = { members: new Map(), summary: summarize(record.group, []) };
          nextGroups.set(record.group, group);
        }
        group.members.set(record.id, record);
      }
      for (const [name, group] of nextGroups)
        group.summary = summarize(name, group.members.values());
      records = nextRecords;
      groups = nextGroups;
    },
  };
}
