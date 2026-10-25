// P0 退出闸③（PLAN-CROSSPLATFORM §P0）：证明 anima 核心与 Claude Code **真解耦**。
//
// 两卷：
//  A. 解耦：一个**完全非 CC** 的假平台（自定义 transcript 格式 + 自造工具名 + 自造合成/回声标记）驱动
//     captureTranscript → situation_log → buildMaterial 全跑通。核心零 CC 假设——换平台=换 Adapter。
//  B. 等价：默认路径（不传 adapter，走本地 CC 函数）与显式传 claudeCodeAdapter，产出**逐字相同**。
//     证 P0 是等价重构，现有 Claude Code 行为一字未变。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { buildMaterial } from "../src/selfReview";
import { listSituations, type SituationRow, type SituationInput } from "../src/situation";
import type { Adapter } from "../src/adapter";
import { claudeCodeAdapter } from "../src/adapters/claudeCode";
import type { TranscriptEntry, ContentBlock } from "../src/transcript";
import type { UserTurnVerdict } from "../src/authorship";

const NOW = "2026-07-06T18:00:00.000Z";
const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-adapter-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
function tmpFile(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), "anima-tx-"));
  tmpDirs.push(d);
  const p = join(d, name);
  writeFileSync(p, content);
  return p;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 比较用：剥掉每行会变的 id/createdAt，只留语义字段。
function semantic(rows: SituationRow[]) {
  return rows.map((r) => ({
    sessionId: r.sessionId,
    project: r.project,
    kind: r.kind,
    payload: r.payload,
    occurredAt: r.occurredAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 卷 A：一个完全非 Claude Code 的假平台 "fauxgent"
//   · transcript 格式：每行 {speaker, id, body, at, project}（字段名全不同于 CC 的 type/uuid/message.content/timestamp/cwd）
//   · 工具语汇：body 里 {op:"patch", file} = 改文件（CC 是 tool_use name=Edit/Write）
//   · 合成轮标记：body 以 "@@AUTO@@" 起手 = 机器合成（CC 是 promptSource='system' / <command-name> 等）
//   · 注入回声：<<fx>>…<</fx>>（CC 是 <system-reminder> / <anima-context>）
// ─────────────────────────────────────────────────────────────────────────────
interface FauxRow {
  speaker: "user" | "assistant";
  id: string;
  at: string;
  project: string;
  body: string | { op: "patch"; file: string; summary: string };
}

const fauxgentAdapter: Adapter = {
  name: "fauxgent",
  parseTranscript(path: string): TranscriptEntry[] {
    if (!existsSync(path)) return [];
    const out: TranscriptEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as FauxRow;
      // 把 fauxgent 私有 schema 翻成中性 TranscriptEntry。工具动作用中性 tool_use 块承载（op/file 塞进 input）。
      let content: string | ContentBlock[];
      if (typeof r.body === "string") content = r.body;
      else content = [{ type: "tool_use", id: `${r.id}-t`, name: "FauxPatch", input: { file: r.body.file, summary: r.body.summary } }];
      out.push({
        type: r.speaker,
        uuid: r.id,
        sessionId: "faux-1",
        cwd: r.project,
        timestamp: r.at,
        isMeta: false,
        isSidechain: false,
        isCompactSummary: false,
        isVisibleInTranscriptOnly: false,
        promptSource: null,
        role: r.speaker,
        content,
      });
    }
    return out;
  },
  extractEvents(entries: TranscriptEntry[]): SituationInput[] {
    const events: SituationInput[] = [];
    for (const e of entries) {
      const base = { sessionId: e.sessionId, project: e.cwd, occurredAt: e.timestamp ?? undefined };
      if (e.type === "user" && typeof e.content === "string") {
        if (this.classifyUserTurn(e) === "synthetic_confirmed") continue; // 合成轮不落库
        const text = this.stripEcho(e.content).trim();
        if (text) events.push({ ...base, kind: "user_message", payload: { text, uuid: e.uuid }, dedupKey: `msg:${e.uuid}` });
      } else if (e.type === "assistant" && Array.isArray(e.content)) {
        for (const b of e.content) {
          if (b.type === "tool_use" && b.name === "FauxPatch") {
            const input = (b.input ?? {}) as { file?: string; summary?: string };
            events.push({
              ...base,
              kind: "file_edit",
              dedupKey: `tool:${b.id}:file_edit`,
              payload: { path: input.file, tool: "FauxPatch", change: input.summary },
            });
          }
        }
      }
    }
    return events;
  },
  classifyUserTurn(entry: TranscriptEntry): UserTurnVerdict {
    if (entry.type !== "user") return "human";
    const t = typeof entry.content === "string" ? entry.content : "";
    return t.trimStart().startsWith("@@AUTO@@") ? "synthetic_confirmed" : "human";
  },
  stripEcho(text: string): string {
    return text.replace(/<<fx>>[\s\S]*?<<\/fx>>/g, "");
  },
};

describe("P0 卷A · 核心跑在完全非 CC 的假平台上（解耦证明）", () => {
  const FAUX_TX = [
    { speaker: "user", id: "f1", at: "2026-07-06T10:00:00.000Z", project: "/proj/x", body: "改一下登录逻辑" },
    { speaker: "assistant", id: "f2", at: "2026-07-06T10:01:00.000Z", project: "/proj/x", body: { op: "patch", file: "auth.ts", summary: "加了空密码校验" } },
    { speaker: "user", id: "f3", at: "2026-07-06T10:02:00.000Z", project: "/proj/x", body: "@@AUTO@@ 后台任务通知：构建完成" },
    { speaker: "user", id: "f4", at: "2026-07-06T10:03:00.000Z", project: "/proj/x", body: "<<fx>>上一轮注入的记忆回声<</fx>>密码为什么还是能空着提交" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");

  test("采集：假平台 transcript → situation_log（真人话留、合成轮弃、回声剥、假工具名识别）", () => {
    const db = tmpDb();
    const path = tmpFile("faux.log", FAUX_TX);
    const res = captureTranscript(db, path, { clock: frozenClock(NOW), adapter: fauxgentAdapter });
    expect(res.captured).toBeGreaterThan(0);

    const rows = listSituations(db, {});
    const kinds = rows.map((r) => r.kind).sort();
    // 真人两句 + 一条 file_edit；合成轮 f3 不落库
    expect(kinds).toEqual(["file_edit", "user_message", "user_message"]);

    const texts = rows.filter((r) => r.kind === "user_message").map((r) => (r.payload as { text: string }).text);
    expect(texts).toContain("改一下登录逻辑");
    // 回声 <<fx>>…<</fx>> 被 adapter.stripEcho 剥掉，只留真问题
    expect(texts).toContain("密码为什么还是能空着提交");
    expect(texts.join("")).not.toContain("注入的记忆回声");
    // 合成轮 @@AUTO@@ 一个字都不该进库
    expect(texts.join("")).not.toContain("@@AUTO@@");
    expect(texts.join("")).not.toContain("后台任务通知");

    // 假工具名 FauxPatch 被 adapter 识别成 file_edit，路径 auth.ts 落库
    const edit = rows.find((r) => r.kind === "file_edit")!;
    expect((edit.payload as { path: string }).path).toBe("auth.ts");
    expect((edit.payload as { tool: string }).tool).toBe("FauxPatch");
  });

  test("素材：假平台 buildMaterial → 对话节选（合成轮/回声都不进）", () => {
    const db = tmpDb();
    const path = tmpFile("faux.log", FAUX_TX);
    captureTranscript(db, path, { clock: frozenClock(NOW), adapter: fauxgentAdapter });

    const material = buildMaterial(db, { transcriptPath: path, sessionId: "faux-1", adapter: fauxgentAdapter });
    const conv = material.conversation.join("\n");
    expect(conv).toContain("改一下登录逻辑");
    expect(conv).toContain("密码为什么还是能空着提交");
    // 合成轮 + 回声均不进对话素材
    expect(conv).not.toContain("@@AUTO@@");
    expect(conv).not.toContain("注入的记忆回声");
    // 真人两句都在、合成/回声都不在 = 假平台的对话素材装配完全走通（project 归一是另一条软约束，不在本卷）
    expect(material.conversation.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 卷 B：默认路径 vs 显式 claudeCodeAdapter，逐字等价（等价重构证明）
// ─────────────────────────────────────────────────────────────────────────────
describe("P0 卷B · 默认路径 === claudeCodeAdapter（等价重构证明）", () => {
  // 真 CC transcript JSONL：一条真人话、一次 Edit 工具调用（含配对 tool_result）、一条 <command-name> 合成轮
  function ccEntry(o: Record<string, unknown>) {
    return JSON.stringify(o);
  }
  const CC_TX = [
    ccEntry({ type: "user", uuid: "c1", sessionId: "cc-1", cwd: "/repo", timestamp: "2026-07-06T11:00:00.000Z", message: { role: "user", content: "修一下这个 bug" } }),
    ccEntry({ type: "assistant", uuid: "c2", sessionId: "cc-1", cwd: "/repo", timestamp: "2026-07-06T11:01:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "fix.ts", old_string: "a", new_string: "b" } }] } }),
    ccEntry({ type: "user", uuid: "c3", sessionId: "cc-1", cwd: "/repo", timestamp: "2026-07-06T11:01:30.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] } }),
    ccEntry({ type: "user", uuid: "c4", sessionId: "cc-1", cwd: "/repo", timestamp: "2026-07-06T11:02:00.000Z", promptSource: "system", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
  ].join("\n");

  test("captureTranscript：situation_log 语义逐字相同", () => {
    const dbDefault = tmpDb();
    const dbCc = tmpDb();
    const p1 = tmpFile("cc.jsonl", CC_TX);
    const p2 = tmpFile("cc.jsonl", CC_TX);
    captureTranscript(dbDefault, p1, { clock: frozenClock(NOW) }); // 默认：不传 adapter，走本地 CC 函数
    captureTranscript(dbCc, p2, { clock: frozenClock(NOW), adapter: claudeCodeAdapter }); // 显式 CC adapter
    expect(semantic(listSituations(dbDefault, {}))).toEqual(semantic(listSituations(dbCc, {})));
    // 且确实采到了东西（防两边都空的假等价）
    expect(listSituations(dbDefault, {}).length).toBeGreaterThan(0);
  });

  test("buildMaterial：Material 逐字相同", () => {
    const dbDefault = tmpDb();
    const dbCc = tmpDb();
    const p1 = tmpFile("cc.jsonl", CC_TX);
    const p2 = tmpFile("cc.jsonl", CC_TX);
    captureTranscript(dbDefault, p1, { clock: frozenClock(NOW) });
    captureTranscript(dbCc, p2, { clock: frozenClock(NOW), adapter: claudeCodeAdapter });
    const mDefault = buildMaterial(dbDefault, { transcriptPath: p1, sessionId: "cc-1" });
    const mCc = buildMaterial(dbCc, { transcriptPath: p2, sessionId: "cc-1", adapter: claudeCodeAdapter });
    expect(mDefault).toEqual(mCc);
    // 合成轮 /clear 不进对话（证 CC 路仍在防合成轮）
    expect(mDefault.conversation.join("\n")).not.toContain("/clear");
    expect(mDefault.conversation.join("\n")).toContain("修一下这个 bug");
  });
});
