import type {
  AdminTechnicianBoard,
  TechnicianApplication,
  TechnicianInvitation,
} from "@zydj/contracts";

export type TechnicianWorkspaceState = {
  scope: string;
  loaded: boolean;
  board: AdminTechnicianBoard | null;
  invitations: TechnicianInvitation[];
  applications: TechnicianApplication[];
};

type Action =
  | { type: "reset"; scope: string }
  | { type: "failed"; scope: string }
  | {
      type: "loaded";
      scope: string;
      board: AdminTechnicianBoard;
      invitations: TechnicianInvitation[];
      applications: TechnicianApplication[];
    }
  | {
      type: "invitation-created";
      scope: string;
      invitation: TechnicianInvitation;
    }
  | {
      type: "invitation-updated";
      scope: string;
      invitation: TechnicianInvitation;
    };

export function emptyTechnicianWorkspace(
  scope: string,
): TechnicianWorkspaceState {
  return {
    scope,
    loaded: false,
    board: null,
    invitations: [],
    applications: [],
  };
}

export function beginScopedWorkspaceRequest(
  requests: { begin: () => () => boolean },
  scope: string,
  currentScope: () => string,
) {
  const isLatest = requests.begin();
  return () => isLatest() && currentScope() === scope;
}

export function createWorkspaceContext() {
  let scope = "";
  let generation = 0;
  return {
    update(nextScope: string) {
      if (nextScope !== scope) {
        scope = nextScope;
        generation++;
      }
      return this.current();
    },
    current() {
      return `${scope}:${generation}`;
    },
  };
}

export function technicianWorkspaceReducer(
  state: TechnicianWorkspaceState,
  action: Action,
): TechnicianWorkspaceState {
  if (action.type === "reset") return emptyTechnicianWorkspace(action.scope);
  // A previous identity/organization request must not restore private data.
  if (action.scope !== state.scope) return state;
  if (action.type === "failed") return emptyTechnicianWorkspace(state.scope);
  if (action.type === "loaded") {
    return {
      scope: state.scope,
      loaded: true,
      board: action.board,
      invitations: action.invitations,
      applications: action.applications,
    };
  }
  if (action.type === "invitation-created") {
    return {
      ...state,
      invitations: [
        action.invitation,
        ...state.invitations.filter((row) => row.id !== action.invitation.id),
      ],
    };
  }
  return {
    ...state,
    invitations: state.invitations.map((row) =>
      row.id === action.invitation.id ? action.invitation : row,
    ),
  };
}
