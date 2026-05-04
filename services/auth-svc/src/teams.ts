// services/auth-svc/src/teams.ts
//
// Issue Owner Groups + branch-scoped teams (T4.21, BAC-A §3.1.7.1.5).
// CAPs in regulatory-svc/cases use `issue_owner_group` to assign work;
// without a teams table that field is a free-text string. This module
// gives auth-svc the team CRUD it needs and the cross-service "is this
// team_id valid?" query the cases service uses for soft validation.
//
// Schema: app_iam.user_teams (1 row per team) + app_iam.user_team_members
// (many-to-many user ↔ team). FK CASCADE on both sides.
//
// Same shape as the rest of auth-svc: in-memory + pg-backed stores
// behind a shared interface, env-driven factory keyed off AUTH_SVC_PG_URL.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface UserTeam {
  team_id: string;
  name: string;
  branch: string;
  role: string;
  team_leader: string;       // user_id
  email: string | null;
  description: string | null;
  created_at: string;
  members: string[];          // user_ids; the leader is implicit but appears here too if added explicitly
}

export interface CreateTeamInput {
  name: string;
  branch: string;
  role: string;
  team_leader: string;        // user_id; must exist in app_iam.users
  email?: string | null;
  description?: string | null;
  /** Optional initial member list (user_ids). The leader is added
   *  automatically — pass [] if no other members yet. */
  members?: string[];
}

export interface ITeamStore {
  init(): Promise<void>;
  list(filters?: { branch?: string; role?: string }): UserTeam[];
  get(team_id: string): UserTeam | undefined;
  create(input: CreateTeamInput): UserTeam;
  delete(team_id: string): boolean;
  addMember(team_id: string, user_id: string): boolean;
  removeMember(team_id: string, user_id: string): boolean;
  /** Test-only — wipe both tables. */
  reset(): Promise<void> | void;
}

function newTeamId(): string {
  return `team_${randomUUID().slice(0, 8)}`;
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// ─── In-memory store (default; used in tests + dev without pg) ──────────

export class InMemoryTeamStore implements ITeamStore {
  private readonly byId = new Map<string, UserTeam>();

  async init(): Promise<void> {
    // no-op
  }

  list(filters: { branch?: string; role?: string } = {}): UserTeam[] {
    return Array.from(this.byId.values())
      .filter((t) => {
        if (filters.branch && t.branch !== filters.branch) return false;
        if (filters.role && t.role !== filters.role) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(team_id: string): UserTeam | undefined {
    return this.byId.get(team_id);
  }

  create(input: CreateTeamInput): UserTeam {
    const trimmed = input.name.trim();
    if (!trimmed) throw httpError(400, "name is required");
    if (!input.branch) throw httpError(400, "branch is required");
    if (!input.role) throw httpError(400, "role is required");
    if (!input.team_leader) throw httpError(400, "team_leader is required");
    // Reject duplicate (name, branch).
    for (const t of this.byId.values()) {
      if (t.name === trimmed && t.branch === input.branch) {
        throw httpError(409, `team "${trimmed}" already exists in branch "${input.branch}"`);
      }
    }
    const initialMembers = new Set<string>(input.members ?? []);
    initialMembers.add(input.team_leader);
    const team: UserTeam = {
      team_id: newTeamId(),
      name: trimmed,
      branch: input.branch,
      role: input.role,
      team_leader: input.team_leader,
      email: input.email ?? null,
      description: input.description ?? null,
      created_at: new Date().toISOString(),
      members: Array.from(initialMembers),
    };
    this.byId.set(team.team_id, team);
    return team;
  }

  delete(team_id: string): boolean {
    return this.byId.delete(team_id);
  }

  addMember(team_id: string, user_id: string): boolean {
    const team = this.byId.get(team_id);
    if (!team) return false;
    if (team.members.includes(user_id)) return false;
    team.members.push(user_id);
    return true;
  }

  removeMember(team_id: string, user_id: string): boolean {
    const team = this.byId.get(team_id);
    if (!team) return false;
    // Refuse to remove the team leader — they must be re-assigned via a
    // future updateLeader() route first. Keeps the leader invariant clean.
    if (team.team_leader === user_id) {
      throw httpError(409, `cannot remove team_leader ${user_id}; reassign leader first`);
    }
    const before = team.members.length;
    team.members = team.members.filter((m) => m !== user_id);
    return team.members.length < before;
  }

  reset(): void {
    this.byId.clear();
  }
}

// ─── Pg-backed store (production target when AUTH_SVC_PG_URL is set) ───

export class PgTeamStore implements ITeamStore {
  private readonly byId = new Map<string, UserTeam>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-team-store] ${m}`, e ?? ""),
  ) {}

  async init(): Promise<void> {
    const teamRows = await this.pool.query<{
      team_id: string;
      name: string;
      branch: string;
      role: string;
      team_leader: string;
      email: string | null;
      description: string | null;
      created_at: Date;
    }>(
      `SELECT team_id, name, branch, role, team_leader, email, description, created_at
         FROM app_iam.user_teams`,
    );
    const memberRows = await this.pool.query<{
      team_id: string;
      user_id: string;
    }>(`SELECT team_id, user_id FROM app_iam.user_team_members ORDER BY team_id, joined_at`);
    const membersByTeam = new Map<string, string[]>();
    for (const r of memberRows.rows) {
      const list = membersByTeam.get(r.team_id) ?? [];
      list.push(r.user_id);
      membersByTeam.set(r.team_id, list);
    }
    this.byId.clear();
    for (const r of teamRows.rows) {
      this.byId.set(r.team_id, {
        team_id: r.team_id,
        name: r.name,
        branch: r.branch,
        role: r.role,
        team_leader: r.team_leader,
        email: r.email,
        description: r.description,
        created_at: r.created_at.toISOString(),
        members: membersByTeam.get(r.team_id) ?? [],
      });
    }
  }

  list(filters: { branch?: string; role?: string } = {}): UserTeam[] {
    return Array.from(this.byId.values())
      .filter((t) => {
        if (filters.branch && t.branch !== filters.branch) return false;
        if (filters.role && t.role !== filters.role) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(team_id: string): UserTeam | undefined {
    return this.byId.get(team_id);
  }

  create(input: CreateTeamInput): UserTeam {
    const trimmed = input.name.trim();
    if (!trimmed) throw httpError(400, "name is required");
    if (!input.branch) throw httpError(400, "branch is required");
    if (!input.role) throw httpError(400, "role is required");
    if (!input.team_leader) throw httpError(400, "team_leader is required");
    for (const t of this.byId.values()) {
      if (t.name === trimmed && t.branch === input.branch) {
        throw httpError(409, `team "${trimmed}" already exists in branch "${input.branch}"`);
      }
    }
    const initialMembers = new Set<string>(input.members ?? []);
    initialMembers.add(input.team_leader);
    const team: UserTeam = {
      team_id: newTeamId(),
      name: trimmed,
      branch: input.branch,
      role: input.role,
      team_leader: input.team_leader,
      email: input.email ?? null,
      description: input.description ?? null,
      created_at: new Date().toISOString(),
      members: Array.from(initialMembers),
    };
    this.byId.set(team.team_id, team);
    // Fire INSERT for the team + each member. Same write-through pattern
    // as the other pg stores in this service. The order matters for FK
    // integrity: team row first, then members. Both are .catch'd so
    // a transient failure doesn't blow up the request.
    void this.pool
      .query(
        `INSERT INTO app_iam.user_teams (
            team_id, name, branch, role, team_leader, email, description, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          team.team_id,
          team.name,
          team.branch,
          team.role,
          team.team_leader,
          team.email,
          team.description,
          new Date(team.created_at),
        ],
      )
      .then(() => {
        // Members go in a separate batch after the team INSERT lands.
        for (const userId of team.members) {
          void this.pool
            .query(
              `INSERT INTO app_iam.user_team_members (team_id, user_id)
                 VALUES ($1, $2)
                 ON CONFLICT (team_id, user_id) DO NOTHING`,
              [team.team_id, userId],
            )
            .catch((err) =>
              this.logger(`failed to insert team member ${team.team_id}/${userId}`, err),
            );
        }
      })
      .catch((err) => this.logger(`failed to insert team ${team.team_id}`, err));
    return team;
  }

  delete(team_id: string): boolean {
    if (!this.byId.has(team_id)) return false;
    this.byId.delete(team_id);
    void this.pool
      .query(`DELETE FROM app_iam.user_teams WHERE team_id = $1`, [team_id])
      .catch((err) => this.logger(`failed to delete team ${team_id}`, err));
    return true;
  }

  addMember(team_id: string, user_id: string): boolean {
    const team = this.byId.get(team_id);
    if (!team) return false;
    if (team.members.includes(user_id)) return false;
    team.members.push(user_id);
    void this.pool
      .query(
        `INSERT INTO app_iam.user_team_members (team_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (team_id, user_id) DO NOTHING`,
        [team_id, user_id],
      )
      .catch((err) => this.logger(`failed to add team member ${team_id}/${user_id}`, err));
    return true;
  }

  removeMember(team_id: string, user_id: string): boolean {
    const team = this.byId.get(team_id);
    if (!team) return false;
    if (team.team_leader === user_id) {
      throw httpError(409, `cannot remove team_leader ${user_id}; reassign leader first`);
    }
    const before = team.members.length;
    team.members = team.members.filter((m) => m !== user_id);
    if (team.members.length === before) return false;
    void this.pool
      .query(
        `DELETE FROM app_iam.user_team_members WHERE team_id = $1 AND user_id = $2`,
        [team_id, user_id],
      )
      .catch((err) => this.logger(`failed to remove team member ${team_id}/${user_id}`, err));
    return true;
  }

  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE app_iam.user_team_members, app_iam.user_teams CASCADE`);
    this.byId.clear();
  }
}
