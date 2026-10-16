export type SchedulingScope = { readonly key: string };

/** A -> B -> A still creates a new scope; previous A replies cannot revive. */
export function createSchedulingRequests() {
  let scope: SchedulingScope | null = null;
  let generation = 0;
  return {
    select(token: string, organizationId: string, date: string) {
      const key = JSON.stringify([token, organizationId, date]);
      if (scope?.key !== key) {
        scope = { key };
        generation += 1;
      }
      return scope;
    },
    begin(selected: SchedulingScope) {
      if (scope !== selected) return () => false;
      const currentGeneration = ++generation;
      return () => scope === selected && generation === currentGeneration;
    },
    invalidate() {
      generation += 1;
    },
  };
}

/** All completion effects, including error/finally, belong to one request. */
export async function runSchedulingOperation<T>({
  isCurrent,
  execute,
  success,
  failure,
  finish,
}: {
  isCurrent: () => boolean;
  execute: () => Promise<T>;
  success: (value: T) => void | Promise<void>;
  failure: (error: unknown) => void;
  finish?: () => void;
}) {
  if (!isCurrent()) return;
  try {
    const value = await execute();
    if (isCurrent()) await success(value);
  } catch (error) {
    if (isCurrent()) failure(error);
  } finally {
    if (isCurrent()) finish?.();
  }
}

export function validSchedulingDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function localMinute(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}:00+08:00`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    new Date(parsed.getTime() + 8 * 3_600_000).toISOString().slice(0, 16) !==
      value
  )
    return null;
  return parsed.toISOString();
}

export function buildSchedulingShift(
  draft: {
    date: string;
    organizationId: string;
    therapistId: string;
    startsAt: string;
    endsAt: string;
  },
  authorization: {
    ready: boolean;
    busy: boolean;
    technicianIds: readonly string[];
  },
) {
  if (
    !authorization.ready ||
    authorization.busy ||
    !draft.organizationId ||
    !authorization.technicianIds.includes(draft.therapistId) ||
    !draft.therapistId ||
    !validSchedulingDate(draft.date) ||
    draft.startsAt.slice(0, 10) !== draft.date
  )
    return null;
  const startsAt = localMinute(draft.startsAt);
  const endsAt = localMinute(draft.endsAt);
  if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt))
    return null;
  // Overnight shifts remain supported; only the start must match the selected day.
  return {
    organizationId: draft.organizationId,
    therapistId: draft.therapistId,
    startsAt,
    endsAt,
  };
}
