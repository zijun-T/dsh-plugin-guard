/**
 * Generation gate + stale-state report — the fix for the failure that started
 * all of this: a host restart interrupts every in-flight turn, and nothing ever
 * writes a terminal state again, so the ledger shows agents "working" forever
 * and claimed tasks are never released.
 *
 * This module never guesses from wall time. It compares a *generation* identity
 * written at process start: anything marked in-flight by an older generation is
 * provably dead, because that process no longer exists.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GENERATION_FILE = 'generation.json';
const OPEN_TURNS_FILE = 'open-turns.json';

/** Write a new generation marker; returns it plus the previous one. */
export async function bootGeneration(stateDir, { pid, now, mode }) {
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, GENERATION_FILE);
  let previous = null;
  try {
    previous = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    previous = null;
  }
  const generation = {
    gen: `g${now}-${pid}`,
    pid,
    startedAt: now,
    mode,
    prevGen: previous?.gen ?? null,
    prevStartedAt: previous?.startedAt ?? null,
  };
  await writeFile(file, `${JSON.stringify(generation, null, 2)}\n`, 'utf8');
  return { ...generation, previous };
}

export async function readOpenTurns(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, OPEN_TURNS_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeOpenTurns(stateDir, turns) {
  try {
    await mkdir(stateDir, { recursive: true });
    const file = join(stateDir, OPEN_TURNS_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(turns, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch {
    /* best-effort: the gate degrades to "no markers", never to a crash */
  }
}

/** Turns left open by a *previous* process — dead by construction. */
export function staleOpenTurns(turns, currentGen, now, staleAfterMs = 0) {
  const out = [];
  for (const [sessionId, entry] of Object.entries(turns ?? {})) {
    if (!entry || entry.gen === currentGen) continue;
    if (staleAfterMs > 0 && now - (entry.since ?? 0) < staleAfterMs) continue;
    out.push({ sessionId, turn: entry.turn ?? null, gen: entry.gen ?? null, since: entry.since ?? null });
  }
  return out;
}

/** Locate every live team ledger under a workspace (archived teams excluded). */
export async function findTeamFiles(workspaceDir, stateDirName = '.agent-teams') {
  const root = join(workspaceDir, stateDirName);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    const file = join(root, entry.name, 'team.json');
    try {
      await readFile(file, 'utf8');
      files.push({ teamId: entry.name, file });
    } catch {
      /* not a team directory */
    }
  }
  return files;
}

/**
 * Report (and optionally repair) members a dead process left "working".
 * A member's `id` is its subagent session id, so liveness is decidable: if that
 * session id is absent from the live registry, no turn can ever finish for it.
 * Repair touches exactly one field per member and records who changed it.
 */
export async function scanTeams(files, { liveSessionIds, repair = false, now = Date.now() }) {
  const report = [];
  for (const { teamId, file } of files) {
    let team;
    try {
      team = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const members = Array.isArray(team.members) ? team.members : [];
    const staleMembers = members.filter((m) => m?.status === 'working' && !liveSessionIds.has(m.id));
    // 任务的 assignee 存的是**成员名字**（实测：'qa' / 'panel-dev'），不是 session id，
    // 所以两种形态都要能匹配上，否则"受影响任务"永远是空。
    const staleIds = new Set(staleMembers.map((m) => m.id));
    const staleNames = new Set(staleMembers.map((m) => m.name));
    const staleTasks = (Array.isArray(team.tasks) ? team.tasks : [])
      .filter((t) => ['claimed', 'in_progress'].includes(t?.status)
        && (staleIds.has(t?.assignee) || staleNames.has(t?.assignee)))
      .map((t) => ({ id: t.id, status: t.status, assignee: t.assignee, subject: t.subject }));
    const entry = {
      teamId, file, phase: team.phase ?? null, escalated: team.escalated === true,
      staleMembers: staleMembers.map((m) => ({ id: m.id, name: m.name, role: m.role })),
      staleTasks,
      repaired: false,
    };
    if (repair && staleMembers.length > 0) {
      for (const member of members) {
        if (!staleIds.has(member.id)) continue;
        member.statusBefore = member.status;
        member.status = 'idle';
        member.statusRepairedBy = 'dsh-guard';
        member.statusRepairedAt = new Date(now).toISOString();
      }
      const tmp = `${file}.dsh-guard.tmp`;
      await writeFile(tmp, `${JSON.stringify(team, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
      entry.repaired = true;
    }
    report.push(entry);
  }
  return report;
}
