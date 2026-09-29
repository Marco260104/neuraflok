import type { SwarmState } from "../../../contracts/session.js";
import { $, el, icon } from "../../shared/dom.js";
import { t, ui } from "../../shared/i18n.js";

export interface SwarmViewActions {
  paintStateLine: () => void;
  paintSessions: () => void;
}

// Owns the agent swarm status list presentation.
export function renderSwarmView(
  state: SwarmState,
  actions: SwarmViewActions,
): void {
  actions.paintStateLine();
  actions.paintSessions();
  const list = $("swarmList");
  if (state.agents.length === 0) {
    list.replaceChildren(
      el(
        "p",
        "hint",
        () =>
          state.retainedHistory
            ? t(
                "No workers are running. Their histories stay available to the chats that started them; Clear workers removes them for good.",
              )
            : t(
                "No agents. The prime agent creates workers with the agents tool’s spawn action.",
              ),
      ),
    );
  } else {
    list.replaceChildren(
      ...state.agents.map((agent) => {
        const row = el("div", "agent");
        const top = el("div", "model-top");
        const label = agent.label || agent.id;
        top.append(el("b", "", label));
        if (label !== agent.id) top.append(el("span", "chip", agent.id));
        top.append(el("span", `chip is-${agent.state}`, agent.state));
        // Clearing a live row ends its owning run or releases the worker slot.
        const over = agent.state === "finished" || agent.state === "failed";
        if (!over) {
          const clear = el("button", "btn btn-quiet agent-clear");
          clear.append(icon("i-x"));
          clear.dataset.clear = agent.id;
          if (agent.runId) clear.dataset.runId = agent.runId;
          ui(clear, "title", () =>
            agent.role === "prime"
              ? t("Clear session — ends this run and every worker in it")
              : t("Clear session — ends {0} and frees its slot", [agent.id]),
          );
          top.append(clear);
        }
        const sub = el("div", "model-sub");
        const bits = [
          t("{0} pending", [agent.pending]),
          t("{0} delivered", [agent.delivered]),
        ];
        if (agent.conversationId) bits.push(t("chat bound"));
        sub.textContent = bits.join(" · ");
        row.append(top, sub);
        if (agent.task) row.append(el("p", "hint", agent.task));
        // Keep the opening failure reason visible for workers that never started.
        if (agent.state === "failed" && agent.result)
          row.append(el("p", "hint is-warn", agent.result));
        return row;
      }),
    );
  }
  // Retained swarm history can still be cleared before another run starts.
  $<HTMLButtonElement>("swarmReset").disabled =
    state.agents.length === 0 && state.retainedHistory !== true;
}
