import { useMemo, useState } from 'react';
import type { WorkflowDetail } from '@comfy-mobile/shared';
import { Icon } from './Icon';
import { Spinner } from './UI';
import { parseWorkflowWarnings, type ParsedWarning } from '../warnings';

interface WorkflowWarningsProps {
  warnings: string[];
  missingNodeTypes: WorkflowDetail['missingNodeTypes'];
  /** Re-read ComfyUI's model/node lists after the user installs a model. */
  onRecheck?: () => void;
  rechecking?: boolean;
}

interface NodeGroup {
  nodeId: string;
  classType: string;
  items: ParsedWarning[];
}

interface AssetGroup {
  classType: string;
  items: ParsedWarning[];
}

interface WiringSummary {
  label: string;
  count: number;
}

function groupByNode(items: ParsedWarning[]): NodeGroup[] {
  const map = new Map<string, NodeGroup>();
  for (const item of items) {
    const nodeId = item.nodeId ?? '';
    const classType = item.classType ?? '';
    const key = `${nodeId}\u0000${classType}`;
    const group = map.get(key) ?? { nodeId, classType, items: [] };
    group.items.push(item);
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => b.items.length - a.items.length);
}

function groupAssets(items: ParsedWarning[]): AssetGroup[] {
  const map = new Map<string, ParsedWarning[]>();
  for (const item of items) {
    const classType = item.classType?.trim() || '其它资源';
    const group = map.get(classType) ?? [];
    group.push(item);
    map.set(classType, group);
  }
  return [...map.entries()]
    .map(([classType, groupItems]) => ({ classType, items: groupItems }))
    .sort((a, b) => b.items.length - a.items.length);
}

function summarizeWiring(items: ParsedWarning[]): WiringSummary[] {
  const map = new Map<string, number>();
  for (const item of items) {
    let label = '其它连线/结构提示';
    if (/muted, or bypassed/i.test(item.raw)) {
      label = '上游节点被静音或旁路，相关连线已断开';
    } else if (/type-mismatched/i.test(item.raw)) {
      label = '类型不匹配的连线已丢弃';
    } else if (/cg-use-everywhere|broadcast/i.test(item.raw)) {
      label = 'cg-use-everywhere 广播连线未能完全还原';
    } else if (/Component|subgraph|expansion/i.test(item.raw)) {
      label = '子图/组件展开时的结构提示';
    } else if (/could not be resolved|ABSENT|UNCONNECTED/i.test(item.raw)) {
      label = '部分连线无法解析，转换后缺失';
    }
    const countMatch = /^(?:Dropped )?(\d+) (?:input connection\(s\)|type-mismatched link\(s\))/.exec(
      item.raw,
    );
    const count = countMatch ? Number(countMatch[1]) : 1;
    map.set(label, (map.get(label) ?? 0) + count);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count }));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Only model/file selectors benefit from re-reading ComfyUI's lists. */
const MODEL_ASSET_INPUT =
  /^(?:ckpt_name|unet_name|lora_name|vae_name|clip_name\d*|model_name|control_net_name|style_model_name|embedding|ipadapter)$/i;
const MODEL_FILE = /\.(?:safetensors|sft|ckpt|pt|pt2|pth|bin|gguf|onnx)$/i;

function isModelAsset(item: ParsedWarning): boolean {
  return MODEL_ASSET_INPUT.test(item.field ?? '') || MODEL_FILE.test(item.savedValue ?? '');
}

export function WorkflowWarnings({
  warnings,
  missingNodeTypes,
  onRecheck,
  rechecking = false,
}: WorkflowWarningsProps) {
  const [open, setOpen] = useState(false);
  const [showAllAssets, setShowAllAssets] = useState(false);
  const [showAllOther, setShowAllOther] = useState(false);

  const parsed = useMemo(
    () => parseWorkflowWarnings(warnings, missingNodeTypes),
    [warnings, missingNodeTypes],
  );

  if (!parsed.items.length) return null;

  const shiftGroups = groupByNode(parsed.items.filter((item) => item.kind === 'shift'));
  const paramItems = parsed.items.filter((item) => item.kind === 'param');
  const paramGroups = groupByNode(paramItems);
  const realAssetItems = parsed.items.filter((item) => item.kind === 'asset' && !item.placeholder);
  const placeholderCount = parsed.items.filter(
    (item) => item.kind === 'asset' && item.placeholder,
  ).length;
  const assetGroups = groupAssets(realAssetItems);
  const modelAssetCount = realAssetItems.filter(isModelAsset).length;
  const visibleAssetGroups = showAllAssets ? assetGroups : assetGroups.slice(0, 4);
  const otherItems = parsed.items.filter((item) => item.kind === 'other');
  const visibleOther = showAllOther ? otherItems : otherItems.slice(0, 3);
  const nonUiTypes = parsed.nodeTypes.filter((type) => !type.uiOnly);
  const uiOnlyTypes = parsed.nodeTypes.filter((type) => type.uiOnly);
  const wiringItems = parsed.items.filter((item) => item.kind === 'wiring');
  const wiringSummaries = summarizeWiring(wiringItems);
  const paramSuspicious =
    !shiftGroups.length && paramGroups.some((group) => group.items.length >= 3);

  return (
    <section className={`warn-banner ${parsed.severity}`}>
      <button
        type="button"
        className="warn-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="alert" size={18} />
        <span className="warn-title">转换提示</span>
        <span className="warn-headline">{parsed.headline}</span>
        <Icon name="chevron" size={16} className={open ? 'rotated' : ''} />
      </button>

      {modelAssetCount && onRecheck ? (
        <div className="warn-recheck-row">
          <button
            type="button"
            className="warn-recheck"
            disabled={rechecking}
            onClick={onRecheck}
          >
            {rechecking ? (
              <Spinner size={14} label="正在重新读取…" />
            ) : (
              <>
                <Icon name="refresh" size={15} />
                <span>重新检查模型</span>
              </>
            )}
          </button>
          <span className="warn-recheck-hint">
            刚下载完模型？点这里重新读取 ComfyUI 的模型列表
          </span>
        </div>
      ) : null}

      {open ? (
        <div className="warn-body">
          {shiftGroups.length ? (
            <section className="warn-section">
              <div className="warn-section-head">
                <span>参数错位</span>
                <span className="warn-badge">{shiftGroups.length}</span>
              </div>
              <p className="warn-section-desc">
                保存的工作流与当前节点定义不一致，部分参数会读错或使用默认值。
              </p>
              {shiftGroups.map((group) => (
                <div className="warn-node" key={`${group.nodeId}-${group.classType}`}>
                  <div className="warn-node-title">
                    Node {group.nodeId || '?'} · {group.classType || '未知节点'}
                  </div>
                  <div className="warn-node-sub">{group.items.length} 处控件值无法可靠映射</div>
                </div>
              ))}
              <div className="warn-callout">
                运行前请在 ComfyUI 中打开这个工作流，重新保存一次，再回到这里刷新。
              </div>
            </section>
          ) : null}

          {paramGroups.length ? (
            <section className="warn-section">
              <div className="warn-section-head">
                <span>参数被替换</span>
                <span className="warn-badge">{paramItems.length}</span>
              </div>
              <p className="warn-section-desc">
                保存的值不在当前 ComfyUI 的可选项里，已自动改用第一个可用选项。
              </p>
              {paramGroups.map((group) => (
                <div className="warn-node" key={`${group.nodeId}-${group.classType}`}>
                  <div className="warn-node-head">
                    <span className="warn-node-title">
                      Node {group.nodeId || '?'} · {group.classType || '未知节点'}
                    </span>
                    <span className="warn-badge">{group.items.length}</span>
                  </div>
                  <ul className="warn-mapping-list">
                    {group.items.map((item, index) => (
                      <li className="warn-mapping" key={`${item.field ?? 'field'}-${index}`}>
                        <code>{item.field ?? '参数'}</code>
                        <span className="warn-mapping-values">
                          <span className="warn-from">{item.savedValue ?? '?'}</span>
                          <span className="warn-arrow">→</span>
                          <span className="warn-to">{item.replacement ?? '默认值'}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {paramSuspicious ? (
                <div className="warn-callout">
                  同一节点有多项参数同时被替换，通常是工作流与当前节点版本不一致。运行前建议在
                  ComfyUI 中重新保存该工作流。
                </div>
              ) : null}
            </section>
          ) : null}

          {realAssetItems.length ? (
            <section className="warn-section">
              <div className="warn-section-head">
                <span>缺少资源</span>
                <span className="warn-badge">{realAssetItems.length}</span>
              </div>
              <p className="warn-section-desc">
                这些文件在当前 ComfyUI 上不存在，运行到对应节点时会报缺失。
              </p>
              {visibleAssetGroups.map((group) => (
                <div className="warn-asset-group" key={group.classType}>
                  <div className="warn-asset-head">
                    <span>{group.classType}</span>
                    <span className="warn-badge">{group.items.length}</span>
                  </div>
                  <ul className="warn-asset-files">
                    {group.items.slice(0, 4).map((item, index) => (
                      <li key={`${item.nodeId ?? 'node'}-${index}`}>
                        <span className="warn-asset-node">Node {item.nodeId || '?'}</span>
                        <code>{item.savedValue || '（空）'}</code>
                      </li>
                    ))}
                    {group.items.length > 4 ? (
                      <li className="warn-muted">还有 {group.items.length - 4} 个文件</li>
                    ) : null}
                  </ul>
                </div>
              ))}
              {assetGroups.length > 4 ? (
                <button
                  type="button"
                  className="warn-more"
                  onClick={() => setShowAllAssets((value) => !value)}
                >
                  {showAllAssets ? '收起' : `显示全部 ${assetGroups.length} 类资源`}
                </button>
              ) : null}
              {placeholderCount ? (
                <p className="warn-muted">{placeholderCount} 个空资源槽位（None）已忽略。</p>
              ) : null}
            </section>
          ) : null}

          {parsed.nodeTypes.length ? (
            <section className="warn-section">
              <div className="warn-section-head">
                <span>节点未安装</span>
                <span className="warn-badge">{parsed.counts.node}</span>
              </div>
              <p className="warn-section-desc">
                缺少执行节点可能导致连线断开；界面辅助节点通常可以忽略。
              </p>
              {nonUiTypes.map((type) => (
                <div className="warn-row" key={type.classType}>
                  <code>{type.classType}</code>
                  <span>× {type.count}</span>
                  <span className="warn-tag">需安装</span>
                </div>
              ))}
              {uiOnlyTypes.length ? (
                <p className="warn-muted">
                  界面辅助节点（可忽略）：
                  {uiOnlyTypes.map((type) => `${type.classType} × ${type.count}`).join('、')}
                </p>
              ) : null}
            </section>
          ) : null}

          {wiringItems.length ? (
            <section className="warn-section">
              <div className="warn-section-head">
                <span>连线与结构</span>
                <span className="warn-badge">{wiringItems.length}</span>
              </div>
              {wiringSummaries.map((summary) => (
                <div className="warn-row" key={summary.label}>
                  <span>{summary.label}</span>
                  <span className="warn-badge">{summary.count}</span>
                </div>
              ))}
              <p className="warn-muted">这些提示通常与在 ComfyUI 里直接运行时的行为一致。</p>
            </section>
          ) : null}

          {otherItems.length ? (
            <section className="warn-section">
              <div className="warn-section-head">
                <span>其它提示</span>
                <span className="warn-badge">{otherItems.length}</span>
              </div>
              <ul className="warn-plain-list">
                {visibleOther.map((item, index) => (
                  <li key={`other-${index}`} title={item.raw}>
                    {truncate(item.raw, 180)}
                  </li>
                ))}
              </ul>
              {otherItems.length > 3 ? (
                <button
                  type="button"
                  className="warn-more"
                  onClick={() => setShowAllOther((value) => !value)}
                >
                  {showAllOther ? '收起' : `显示全部 ${otherItems.length} 条`}
                </button>
              ) : null}
            </section>
          ) : null}

          <details className="warn-raw">
            <summary>原始提示（{parsed.items.length} 条）</summary>
            <ul>
              {parsed.items.map((item, index) => (
                <li key={`raw-${index}`}>{item.raw}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}
