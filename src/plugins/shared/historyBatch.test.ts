// @vitest-environment node
/**
 * A normalizer's `appendTransaction` can tell when it is being asked to react
 * to an undo or redo — directly, or to a transaction already appended to one.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { history, redo, undo } from "@tiptap/pm/history";
import { isHistoryBatch } from "./historyBatch";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
});

/** Record the batch every appendTransaction call receives, and optionally append once. */
function recorder(appendOnFirstHistoryCall: boolean) {
  const seen: boolean[][] = [];
  let appended = false;
  const plugin = new Plugin({
    appendTransaction(transactions: readonly Transaction[], _old, newState) {
      seen.push([isHistoryBatch(transactions)]);
      if (appendOnFirstHistoryCall && !appended && isHistoryBatch(transactions)) {
        appended = true;
        return newState.tr.setMeta("marker", true);
      }
      return null;
    },
  });
  return { plugin, seen };
}

function typedState(plugins: Plugin[]): EditorState {
  let state = EditorState.create({ schema, plugins: [history(), ...plugins] });
  state = state.apply(state.tr.insertText("abc", 1));
  return state;
}

describe("isHistoryBatch", () => {
  it("is false for an ordinary edit", () => {
    const { plugin, seen } = recorder(false);
    typedState([plugin]);
    expect(seen).toEqual([[false]]);
  });

  it("is true for an undo and for a redo", () => {
    const { plugin, seen } = recorder(false);
    let state = typedState([plugin]);
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    redo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(seen.slice(1)).toEqual([[true], [true]]);
  });

  // The second loop iteration hands a plugin only the transactions appended
  // since its last call, without the undo itself.
  it("is true for a transaction appended to an undo", () => {
    const first = recorder(true);
    const second = recorder(false);
    let state = typedState([second.plugin, first.plugin]);
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(second.seen.slice(1)).toEqual([[true], [true]]);
  });

  it("is false for an empty batch", () => {
    expect(isHistoryBatch([])).toBe(false);
  });
});
