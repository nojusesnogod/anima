// Codex CLI 转接头（P2）：Adapter 接口的**第一个非 Claude Code 实现**——"招牌功能能否跨 agent"的试金石。
//
// 格式逆向自真实 Codex rollout（~/.codex/sessions/**/rollout-*.jsonl，codex-cli 0.133）：
//   每行 = {type, timestamp(ISO-UTC Z), payload}
//   · session_meta      payload:{id=会话id, cwd, ...}          ← 会话级：id/cwd 应用到全部条目
//   · response_item     payload.type:
//       message              {role: user|developer|assistant, content:[{type,text}]}
//       function_call        {name(exec_command|view_image), arguments(JSON 字串), call_id}
//       function_call_output {call_id, output(字串)}
//       reasoning            {encrypted_content,...}            ← 加密模型思考，跳过
//   · event_msg / turn_context                                 ← UI 事件/回合上下文，跳过
//
// Codex 工具面极简：几乎只有 exec_command（跑 shell）——改文件也走 shell(apply_patch)，故按**命令字串**
// 归类 test_run / file_edit(apply_patch) / command_run（同 CC 对 Bash 的归类，shell 语义平台无关）。
// harness 注入：developer 轮=系统指令(<permissions instructions>...) → 合成；user 轮里裹
// <environment_context>…</environment_context> → stripEcho 剥（同 CC 剥 <system-reminder>）。
//
// ⚠️ Codex 官方明说 rollout 非稳定接口、会变 → 解析全程坏行/缺字段容忍（try/catch + 可选链）。
// uuid：rollout 无逐行 id，用**文件行序号**当不透明有序 id（append-only 内稳定，满足 anima「只比序不解析」契约）。
import { existsSync, readFileSync } from "node:fs";
import type { Adapter } from "../adapter";
import type { TranscriptEntry, ContentBlock } from "../transcript";
import type { SituationInput } from "../situation";
import type { UserTurnVerdict } from "../authorship";
import { normalizeProject } from "../project";
import { scrubSecrets, classifyCommand } from "../capture";

// ── 复用性：以下 shell 语义判据平台无关，与 capture.ts 同哲学，Codex 侧本地保留一份（避免拓宽 capture 导出面）──
const TEST_CMD_RE =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bvitest\b|\bjest\b/;
const CMD_OUTPUT_HEAD = 150;
const CMD_OUTPUT_TAIL = 150;
const OUTPUT_REDACTED_CATEGORIES = new Set(["deploy", "net", "install", "build"]);
function headTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)} …(${s.length - head - tail}字省略)… ${s.slice(s.length - tail)}`;
}
/** apply_patch 改文件：Codex 用 `apply_patch <<'EOF' *** Update/Add/Delete File: <path>` 走 shell。抽首个受影响文件路径。 */
function applyPatchPath(cmd: string): string | null {
  if (!/\bapply_patch\b/.test(cmd)) return null;
  const m = cmd.match(/\*\*\*\s+(?:Update|Add|Delete) File:\s+(\S+)/);
  return m ? m[1]! : null;
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: any;
}

/** 从一条 message 的 content 数组拍平出文本（{type,text} 块拼接）。 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const b of content) if (b && typeof b.text === "string") s += b.text;
  return s;
}

export const codexAdapter: Adapter = {
  name: "codex",

  parseTranscript(path: string): TranscriptEntry[] {
    if (!existsSync(path)) return [];
    let sessionId: string | null = null;
    let cwd: string | null = null;
    const out: TranscriptEntry[] = [];
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      let obj: CodexLine;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 坏行不致命
      }
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
      const p = obj.payload ?? {};
      // 会话元：拿 id/cwd 应用到后续全部条目
      if (obj.type === "session_meta") {
        if (typeof p.id === "string") sessionId = p.id;
        if (typeof p.cwd === "string") cwd = p.cwd;
        continue;
      }
      if (obj.type !== "response_item") continue;
      const uuid = String(i); // 文件行序号 = 不透明有序 id（append-only 内稳定）
      const base = { uuid, sessionId, cwd, timestamp: ts, isMeta: false, isSidechain: false, isCompactSummary: false, isVisibleInTranscriptOnly: false, promptSource: null } as const;

      if (p.type === "message" && typeof p.role === "string") {
        const text = messageText(p.content);
        const type: "user" | "assistant" = p.role === "assistant" ? "assistant" : "user";
        // developer/system 走 user 型 + role=developer（classifyUserTurn 据此判合成）
        out.push({ ...base, type, role: p.role, content: [{ type: "text", text }] });
      } else if (p.type === "function_call" && typeof p.call_id === "string") {
        // 工具调用 → assistant 的 tool_use 块（把 exec_command 的 cmd/workdir 塞进 input，供 extractEvents 归类）
        let args: any = {};
        try {
          args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments ?? {});
        } catch {
          args = {};
        }
        const block: ContentBlock = { type: "tool_use", id: p.call_id, name: typeof p.name === "string" ? p.name : "unknown", input: args };
        out.push({ ...base, type: "assistant", role: "assistant", content: [block] });
      } else if (p.type === "function_call_output" && typeof p.call_id === "string") {
        // 工具结果 → tool_result 块（承载 output；Codex 无显式 is_error，默认 false）
        const block: ContentBlock = { type: "tool_result", tool_use_id: p.call_id, content: typeof p.output === "string" ? p.output : "", is_error: false };
        out.push({ ...base, type: "user", role: "tool", content: [block] });
      }
      // reasoning / 其它：跳过（加密思考不入记忆）
    }
    return out;
  },

  extractEvents(entries: TranscriptEntry[]): SituationInput[] {
    const events: SituationInput[] = [];
    const pending = new Map<string, { command?: string }>();
    for (const e of entries) {
      const base = { sessionId: e.sessionId, project: normalizeProject(e.cwd), occurredAt: e.timestamp ?? undefined };
      if (e.type === "assistant" && Array.isArray(e.content)) {
        for (const block of e.content) {
          if (block.type !== "tool_use" || !block.id) continue;
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (block.name === "exec_command") {
            pending.set(block.id, { command: typeof input.cmd === "string" ? input.cmd : undefined });
          }
        }
        continue;
      }
      if (e.type !== "user" || !Array.isArray(e.content)) continue;
      // 合成（developer）轮：不落 user_message
      const synthetic = this.classifyUserTurn(e) === "synthetic_confirmed";
      let userText = "";
      for (const block of e.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const tool = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          const output = this.stripEcho(typeof block.content === "string" ? block.content : "");
          const cmd = tool?.command;
          if (!cmd) continue;
          if (TEST_CMD_RE.test(cmd)) {
            const m = output.match(/(\d+)\s*fail/i);
            const passed = m ? parseInt(m[1]!, 10) === 0 : true;
            const scrubbed = scrubSecrets(cmd);
            events.push({ ...base, kind: "test_run", dedupKey: `tool:${block.tool_use_id}:test_run`, payload: { command: scrubbed !== cmd ? "[命令含疑似密钥，未采]" : scrubbed, ok: passed } });
            continue;
          }
          const editPath = applyPatchPath(cmd);
          if (editPath) {
            events.push({ ...base, kind: "file_edit", dedupKey: `tool:${block.tool_use_id}:file_edit`, payload: { path: editPath, tool: "apply_patch", change: headTail(scrubSecrets(cmd), 100, 100) } });
            continue;
          }
          const cat = classifyCommand(cmd);
          if (cat) {
            const scrubbed = scrubSecrets(cmd);
            const hadSecret = scrubbed !== cmd;
            events.push({ ...base, kind: "command_run", dedupKey: `tool:${block.tool_use_id}:command_run`, payload: { command: hadSecret ? "[命令含疑似密钥，未采]" : scrubbed, category: cat, ok: true, output: OUTPUT_REDACTED_CATEGORIES.has(cat) ? "[输出正文未采：此类命令输出可能含无名低熵密钥]" : headTail(scrubSecrets(output), CMD_OUTPUT_HEAD, CMD_OUTPUT_TAIL) } });
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          userText += block.text;
        }
      }
      const text = this.stripEcho(userText).trim();
      if (text && !synthetic) events.push({ ...base, kind: "user_message", payload: { text, uuid: e.uuid }, dedupKey: `msg:${e.uuid}` });
    }
    return events;
  },

  classifyUserTurn(entry: TranscriptEntry): UserTurnVerdict {
    if (entry.type !== "user") return "human";
    // Codex 角色分明：developer=系统注入指令（<permissions instructions>），tool=工具结果 → 均非真人。
    if (entry.role === "developer" || entry.role === "tool") return "synthetic_confirmed";
    return "human";
  },

  stripEcho(text: string): string {
    // 剥 Codex harness 注入 + anima 自注入。全是**机器生成、非用户原话**：
    //   <environment_context>…  = 会话环境注入进 user 轮
    //   <permissions instructions>… = developer 权限指令
    //   <turn_aborted>…          = 用户打断上一回合时 harness 以 role=user 塞的机器通知（考官逮到 7 例真泄漏：
    //                              它既非 developer 也非 tool 角色，classifyUserTurn 判 human → 会被当用户原话存，
    //                              剥掉后整条为空即不落库/不入对话，与 environment_context 同哲学）
    //   <anima-context>…         = anima 自己的晨间注入
    return text
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
      .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
      .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, "")
      .replace(/<anima-context>[\s\S]*?<\/anima-context>/g, "");
  },
};
