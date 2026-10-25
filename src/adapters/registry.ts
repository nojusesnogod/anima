// 转接头选型（P0）：生产运行时选哪个平台的 Adapter。
//
// 由**编排根 / 入口**引：hooks/*.ts、`src/digest.ts` 的夜跑编排（runNightlyDigestion/healAllNow）、
// `src/worker.ts`（processReviewItem/enqueueReviewForStop）——它们是"决定本进程为哪个平台跑"的组合点，
// 在此解析默认 adapter。**纯消费核心**（capture/selfReview/situation/experiences/…）**不引本文件**：
// 只 `import type { Adapter }` 并"收下"一个 Adapter 作参数（缺省走各自本地 CC 函数）。这样运行时依赖
// 单向流动（registry → claudeCode → transcript/capture/…），与核心无环、且不拉 transformers（保 worker 热路径）。
//
// P0 只注册 claude-code。加平台（P2 Codex 起）= 在 REGISTRY 里多挂一行，入口按 ANIMA_ADAPTER 选。
import type { Adapter } from "../adapter";
import { claudeCodeAdapter } from "./claudeCode";
import { codexAdapter } from "./codex";

const REGISTRY: Record<string, Adapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

export const DEFAULT_ADAPTER = "claude-code";

/** 按 ANIMA_ADAPTER 环境变量选活动转接头；未设＝claude-code。未知名字直接抛（绝不静默退默认）。 */
export function getActiveAdapter(): Adapter {
  const name = process.env.ANIMA_ADAPTER ?? DEFAULT_ADAPTER;
  const adapter = REGISTRY[name];
  if (!adapter) {
    throw new Error(
      `未知 ANIMA_ADAPTER="${name}"；已注册：${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return adapter;
}
