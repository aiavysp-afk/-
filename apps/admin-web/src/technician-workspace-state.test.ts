import { describe, expect, it } from "vitest";
import type {
  AdminTechnicianBoard,
  TechnicianApplication,
  TechnicianInvitation,
} from "@zydj/contracts";
import {
  beginScopedWorkspaceRequest,
  createWorkspaceContext,
  emptyTechnicianWorkspace,
  technicianWorkspaceReducer,
} from "./technician-workspace-state";
import { createLatestRequest } from "./synchronization";

const scope = "organization-a:session-a";
const board: AdminTechnicianBoard = {
  day: "2026-10-13",
  timeZone: "Asia/Shanghai",
  generatedAt: "2026-10-13T02:00:00.000Z",
  technicians: [],
};
const application = {
  technicianId: "applicant-a",
  status: "PENDING_REVIEW",
} as TechnicianApplication;
const invitation = {
  id: "invite-a",
  status: "PENDING",
} as TechnicianInvitation;

function loadedState() {
  return technicianWorkspaceReducer(emptyTechnicianWorkspace(scope), {
    type: "loaded",
    scope,
    board,
    invitations: [invitation],
    applications: [application],
  });
}

describe("technician management private load state", () => {
  it("rejects an A to B to A invitation response even before another request begins", () => {
    const requests = createLatestRequest();
    const context = createWorkspaceContext();
    const firstA = context.update(scope);
    const oldMutation = beginScopedWorkspaceRequest(requests, firstA, () =>
      context.current(),
    );
    expect(oldMutation()).toBe(true);
    context.update("organization-b:session-b");
    expect(oldMutation()).toBe(false);
    const secondA = context.update(scope);
    expect(secondA).not.toBe(firstA);
    expect(oldMutation()).toBe(false);
    expect(context.update(scope)).toBe(secondA);
    const latestMutation = beginScopedWorkspaceRequest(requests, secondA, () =>
      context.current(),
    );
    expect(latestMutation()).toBe(true);
    expect(oldMutation()).toBe(false);
  });

  it("fences every invitation success, error and finally effect before context cleanup runs", () => {
    const requests = createLatestRequest();
    let currentScope = scope;
    const oldMutation = beginScopedWorkspaceRequest(
      requests,
      scope,
      () => currentScope,
    );
    expect(oldMutation()).toBe(true);
    currentScope = "organization-a:session-b";
    expect(oldMutation()).toBe(false);
    const newMutation = beginScopedWorkspaceRequest(
      requests,
      currentScope,
      () => currentScope,
    );
    let busy = true;
    let secret = "new-context-secret";
    if (oldMutation()) {
      busy = false;
      secret = "old-context-secret";
    }
    expect(busy).toBe(true);
    expect(secret).toBe("new-context-secret");
    expect(newMutation()).toBe(true);
  });

  it("fences an earlier request generation and invalidates responses on unmount", () => {
    const requests = createLatestRequest();
    const first = beginScopedWorkspaceRequest(requests, scope, () => scope);
    const second = beginScopedWorkspaceRequest(requests, scope, () => scope);
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    requests.invalidate();
    expect(second()).toBe(false);
  });

  it("does not represent an unread queue as a successfully empty queue", () => {
    expect(emptyTechnicianWorkspace(scope).loaded).toBe(false);
  });

  it("accepts all successfully loaded resources together", () => {
    expect(loadedState()).toEqual({
      scope,
      loaded: true,
      board,
      invitations: [invitation],
      applications: [application],
    });
  });

  it("clears cached applications and invitations when any queue read fails", () => {
    expect(
      technicianWorkspaceReducer(loadedState(), { type: "failed", scope }),
    ).toEqual(emptyTechnicianWorkspace(scope));
  });

  it("recognizes an actually successful empty queue", () => {
    const state = technicianWorkspaceReducer(emptyTechnicianWorkspace(scope), {
      type: "loaded",
      scope,
      board,
      invitations: [],
      applications: [],
    });
    expect(state.loaded).toBe(true);
    expect(state.applications).toEqual([]);
  });

  it.each(["organization-b:session-a", "organization-a:session-b"])(
    "clears private resources when the current context changes to %s",
    (nextScope) => {
      const current = technicianWorkspaceReducer(loadedState(), {
        type: "reset",
        scope: nextScope,
      });
      expect(current).toEqual(emptyTechnicianWorkspace(nextScope));
      const staleRead = technicianWorkspaceReducer(current, {
        type: "loaded",
        scope,
        board,
        invitations: [invitation],
        applications: [application],
      });
      expect(staleRead).toBe(current);
      expect(
        technicianWorkspaceReducer(current, { type: "failed", scope }),
      ).toBe(current);
    },
  );

  it("ignores invitation responses from a former identity or organization", () => {
    const current = emptyTechnicianWorkspace("organization-b:session-b");
    expect(
      technicianWorkspaceReducer(current, {
        type: "invitation-created",
        scope,
        invitation,
      }),
    ).toBe(current);
    expect(
      technicianWorkspaceReducer(current, {
        type: "invitation-updated",
        scope,
        invitation,
      }),
    ).toBe(current);
  });

  it("updates invitations without replacing the confirmed application queue", () => {
    const created = technicianWorkspaceReducer(loadedState(), {
      type: "invitation-created",
      scope,
      invitation,
    });
    expect(created.invitations).toEqual([invitation]);
    const revoked = { ...invitation, status: "REVOKED" as const };
    const updated = technicianWorkspaceReducer(created, {
      type: "invitation-updated",
      scope,
      invitation: revoked,
    });
    expect(updated.invitations).toEqual([revoked]);
    expect(updated.applications).toEqual([application]);
    expect(updated.loaded).toBe(true);
  });
});
