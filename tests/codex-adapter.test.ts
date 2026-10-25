// P2 试金石：codexAdapter（第一个非 Claude Code 适配器）把**真实 Codex rollout 格式**（codex-cli 0.133，
// 逆向自 ~/.codex/sessions/**/rollout-*.jsonl）驱动 anima 核心 capture→situation_log→buildMaterial 跑通。
// 证 P0 Adapter 接口对一个真·第二平台成立。fixture 用合成 rollout（不动用户真实 Codex 会话内容）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { buildMaterial } from "../src/selfReview";
import { listSituations } from "../src/situation";
import { codexAdapter } from "../src/adapters/codex";
import { getActiveAdapter } from "../src/adapters/registry";

const NOW = "2026-07-06T18:00:00.000Z";
const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-codex-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
function tmpFile(content: string): string {
  const d = mkdtempSync(join(tmpdir(), "anima-cxtx-"));
  tmpDirs.push(d);
  const p = join(d, "rollout.jsonl");
  writeFileSync(p, content);
  return p;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 合成 Codex rollout（每行 {type,timestamp,payload}），照真实 codex-cli 0.133 结构造：
const T = "2026-07-06T10:0";
const ROLLOUT = [
  { type: "session_meta", timestamp: T + "0:00.000Z", payload: { id: "cx-1", cwd: "/proj/x", cli_version: "0.133.0" } },
  { type: "turn_context", timestamp: T + "0:01.000Z", payload: { model: "gpt" } },
  // developer 轮 = 系统注入指令 → 合成，不落 user_message、不进对话
  { type: "response_item", timestamp: T + "0:02.000Z", payload: { type: "message", role: "developer", content: [{ type: "text", text: "<permissions instructions>\n允许读写仓库\n</permissions instructions>" }] } },
  // user 轮裹 <environment_context> 注入 → stripEcho 剥掉，只留真问题
  { type: "response_item", timestamp: T + "0:03.000Z", payload: { type: "message", role: "user", content: [{ type: "text", text: "<environment_context>\ncwd=/proj/x\n</environment_context>帮我把登录 bug 修了" }] } },
  // <turn_aborted> = 用户打断上一回合时 harness 以 role=user 塞的机器通知（考官逮到的真泄漏）→ 不该当用户原话存
  { type: "response_item", timestamp: T + "0:03.500Z", payload: { type: "message", role: "user", content: [{ type: "text", text: "<turn_aborted>The user interrupted the previous turn on purpose.</turn_aborted>" }] } },
  // exec_command 跑普通命令 → command_run（git 类）
  { type: "response_item", timestamp: T + "0:04.000Z", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "git status", workdir: "/proj/x" }) } },
  { type: "response_item", timestamp: T + "0:05.000Z", payload: { type: "function_call_output", call_id: "c1", output: "On branch main\nnothing to commit" } },
  // exec_command 跑 apply_patch 改文件 → file_edit（抽路径）
  { type: "response_item", timestamp: T + "0:06.000Z", payload: { type: "function_call", name: "exec_command", call_id: "c2", arguments: JSON.stringify({ cmd: "apply_patch <<'EOF'\n*** Update File: src/auth.ts\n@@\n-old\n+new\n*** End Patch\nEOF", workdir: "/proj/x" }) } },
  { type: "response_item", timestamp: T + "0:07.000Z", payload: { type: "function_call_output", call_id: "c2", output: "Success. Updated src/auth.ts" } },
  // exec_command 跑测试 → test_run（0 fail = 过）
  { type: "response_item", timestamp: T + "0:08.000Z", payload: { type: "function_call", name: "exec_command", call_id: "c3", arguments: JSON.stringify({ cmd: "bun test", workdir: "/proj/x" }) } },
  { type: "response_item", timestamp: T + "0:09.000Z", payload: { type: "function_call_output", call_id: "c3", output: "12 pass\n0 fail" } },
  // 加密思考 → 跳过
  { type: "response_item", timestamp: T + "1:00.000Z", payload: { type: "reasoning", encrypted_content: "xxxx", summary: [] } },
  // assistant 文本 → 进对话（我：…），非 user_message
  { type: "response_item", timestamp: T + "1:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "修好了，空密码现在会被拒。" }] } },
  // 第二条真人话
  { type: "response_item", timestamp: T + "1:02.000Z", payload: { type: "message", role: "user", content: [{ type: "text", text: "跑一下测试确认" }] } },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

describe("P2 · codexAdapter 把真实 Codex rollout 格式跑通 anima 核心（试金石）", () => {
  test("registry 注册了 codex（ANIMA_ADAPTER=codex 可选中）", () => {
    const saved = process.env.ANIMA_ADAPTER;
    process.env.ANIMA_ADAPTER = "codex";
    try {
      expect(getActiveAdapter()).toBe(codexAdapter);
      expect(getActiveAdapter().name).toBe("codex");
    } finally {
      if (saved === undefined) delete process.env.ANIMA_ADAPTER;
      else process.env.ANIMA_ADAPTER = saved;
    }
  });

  test("采集：Codex rollout → situation_log（命令/编辑/测试识别，developer 弃，env_context 剥）", () => {
    const db = tmpDb();
    const path = tmpFile(ROLLOUT);
    const res = captureTranscript(db, path, { clock: frozenClock(NOW), adapter: codexAdapter });
    expect(res.captured).toBeGreaterThan(0);

    const rows = listSituations(db, {});
    const byKind = (k: string) => rows.filter((r) => r.kind === k);

    // 两条真人话；developer 轮与 env_context 都不入
    const msgs = byKind("user_message").map((r) => (r.payload as { text: string }).text);
    expect(msgs).toContain("帮我把登录 bug 修了");
    expect(msgs).toContain("跑一下测试确认");
    expect(msgs.join("")).not.toContain("environment_context");
    expect(msgs.join("")).not.toContain("允许读写仓库"); // developer 指令不入
    expect(msgs.join("")).not.toContain("permissions instructions");
    // <turn_aborted> 机器打断通知不该当用户原话落库（考官逮到的真泄漏，回归守卫）
    expect(msgs.join("")).not.toContain("turn_aborted");
    expect(msgs.join("")).not.toContain("interrupted the previous turn");
    expect(msgs.length).toBe(2); // 恰两条真人话，turn_aborted 空后不落

    // exec_command git → command_run（category git）
    const cmds = byKind("command_run");
    expect(cmds.length).toBe(1);
    expect((cmds[0]!.payload as { category: string }).category).toBe("git");

    // apply_patch → file_edit（路径 src/auth.ts）
    const edits = byKind("file_edit");
    expect(edits.length).toBe(1);
    expect((edits[0]!.payload as { path: string }).path).toBe("src/auth.ts");
    expect((edits[0]!.payload as { tool: string }).tool).toBe("apply_patch");

    // bun test 0 fail → test_run ok=true
    const tests = byKind("test_run");
    expect(tests.length).toBe(1);
    expect((tests[0]!.payload as { ok: boolean }).ok).toBe(true);
  });

  test("素材：buildMaterial → 对话节选（真人话 + assistant，developer/env_context/工具都不进）", () => {
    const db = tmpDb();
    const path = tmpFile(ROLLOUT);
    captureTranscript(db, path, { clock: frozenClock(NOW), adapter: codexAdapter });
    const material = buildMaterial(db, { transcriptPath: path, sessionId: "cx-1", adapter: codexAdapter });
    const conv = material.conversation.join("\n");
    expect(conv).toContain("帮我把登录 bug 修了");
    expect(conv).toContain("跑一下测试确认");
    expect(conv).toContain("修好了"); // assistant 文本进对话
    expect(conv).not.toContain("environment_context");
    expect(conv).not.toContain("允许读写仓库");
    // 事件流水也进素材（file_edit/command_run/test_run 在 events 白名单里）
    expect(material.events.join("\n")).toContain("src/auth.ts");
  });
});
