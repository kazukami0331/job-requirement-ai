"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HiringPlan, MergedApplication, Snapshot } from "@/types/recruiting";
import { buildSnapshot } from "@/lib/recruiting/parse";
import { mergeSnapshots, statusMovements } from "@/lib/recruiting/merge";
import {
  Dimension,
  DIMENSION_LABEL,
  breakdown,
  funnel,
  kpis,
  recentWeekKeys,
  rejectReasons,
  stagePool,
  weeklyMatrix,
  weeklyTrend,
} from "@/lib/recruiting/aggregate";
import { parsePlanFile, shortageByShop, totalShortage } from "@/lib/recruiting/plan";
import { normalizeShopKey } from "@/lib/recruiting/shops";
import { buildWorkbookSheets, downloadJson, downloadWorkbook } from "@/lib/recruiting/export";
import {
  applyShared,
  deletePlan,
  deleteSnapshot,
  loadSeedIfEmpty,
  markSeedLoaded,
  exportBackup,
  importBackup,
  listSnapshots,
  loadPlan,
  savePlan,
  saveSnapshot,
  setSharedAt,
} from "@/lib/recruiting/storage";
import { fetchShared, publishShared } from "@/lib/recruiting/shared";
import { Button, Card, EmptyState, Legend, StatTile } from "@/components/dashboard/ui";
import { FunnelChart, StagePoolChart, WeeklyTrendChart } from "@/components/dashboard/charts";
import { BreakdownTable, WeeklyMatrixTable } from "@/components/dashboard/tables";
import { DataMenu } from "@/components/dashboard/DataPanel";
import { DEFAULT_RATES, GoalRates, GoalWindow, monthlyGoals } from "@/lib/recruiting/goal";
import { Coverage, GoalControls, GoalView, MetricSwitch, MonthSummary, MonthlyGoalTable } from "@/components/dashboard/goals";

type Message = { kind: "info" | "error"; text: string } | null;

const DIMENSIONS: Dimension[] = ["shopShortName", "employmentType", "media", "route", "jobTitle"];

type SectionKey = "summary" | "goal" | "trend" | "breakdown" | "activity";

/** 2026-09-21 → 9/21 */
const md = (d?: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");

/** 並びは画面の上から下と同じ。スマホのタブもこの順で出る。 */
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "summary", label: "サマリー" },
  { key: "goal", label: "月次目標" },
  { key: "trend", label: "週次推移" },
  { key: "breakdown", label: "選考状況" },
  { key: "activity", label: "動き" },
];

/** 集計の軸を切り替える。週次推移と選考状況の2枚が離れた位置に出るので、両方に置く。 */
function DimensionSwitch({ value, onChange }: { value: Dimension; onChange: (d: Dimension) => void }) {
  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
      {DIMENSIONS.map((d) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className="shrink-0 rounded-lg border px-2 py-1 text-xs"
          style={{
            borderColor: d === value ? "var(--series-1)" : "var(--hairline)",
            color: d === value ? "var(--series-1)" : "var(--text-secondary)",
            fontWeight: d === value ? 600 : 400,
          }}
          aria-pressed={d === value}
        >
          {DIMENSION_LABEL[d]}
        </button>
      ))}
    </div>
  );
}

/** 集計期間の選択肢。今期＝9月始まりの採用期。 */
type Period = "term" | "all";

/** 対象の校舎。master＝不足人数マスタに採用目標がある校舎だけ。 */
type Scope = "master" | "all";

function readFile(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export default function DashboardPage() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [plan, setPlan] = useState<HiringPlan | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [loading, setLoading] = useState(true);
  const [dimension, setDimension] = useState<Dimension>("shopShortName");
  const [employmentFilter, setEmploymentFilter] = useState<string>("すべて");
  // スマホでは縦に長くなりすぎるのでセクションを切り替える。画面が広いときは全部並べる。
  const [section, setSection] = useState<SectionKey>("summary");
  // 公開データ（サーバーに置いてある共有データ）の状態。
  // configured が false のときは保存先が未設定で、同梱データだけで動いている。
  const [shared, setShared] = useState<{ configured: boolean; publishedAt: string | null }>({
    configured: false,
    publishedAt: null,
  });
  // 集計期間。既定は今期（9月始まり）。全期間は旧運用ぶんも含めて見たいときだけ。
  const [period, setPeriod] = useState<Period>("term");
  // 対象の校舎。既定は不足人数マスタに載っている校舎だけ。
  const [scope, setScope] = useState<Scope>("master");
  // 歩留まりの想定値。実績を見ながら手で動かせるようにしておく。
  const [rates, setRates] = useState<GoalRates>(DEFAULT_RATES);
  // 既定は3指標まとめて。応募だけ・採用だけを見たいときは絞り込める。
  const [goalView, setGoalView] = useState<GoalView>("all");
  // 按分する期間。未選択のうちは monthlyGoals 側の既定（当月〜一番遅い期限）に任せる。
  const [goalWindow, setGoalWindow] = useState<GoalWindow | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // 保存先がブラウザごとなので、まず公開データを見に行く。
        // これがあれば、URLを開いただけの人にも取り込んだ本人と同じ数字が出る。
        const remote = await fetchShared();
        let pulled = false;
        if (remote?.data && remote.publishedAt) {
          pulled = await applyShared(remote.data, remote.publishedAt);
        }
        setShared({ configured: remote?.configured ?? false, publishedAt: remote?.publishedAt ?? null });

        // 公開データが無いときだけ、同梱してある受領済みデータを入れる
        const seeded = remote?.data ? false : await loadSeedIfEmpty();
        const [s, p] = await Promise.all([listSnapshots(), loadPlan()]);
        setSnapshots(s);
        setPlan(p);
        if (pulled) {
          setMessage({ kind: "info", text: "公開データを読み込みました。" });
        } else if (seeded) {
          setMessage({
            kind: "info",
            text: "すでにお預かりしている分を初期データとして読み込みました。次の週からは「応募データを取り込む」で追加してください。",
          });
        }
      } catch {
        setMessage({ kind: "error", text: "保存データの読み込みに失敗しました。" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** 全スナップショットを串刺しにした応募一覧 */
  const allApps: MergedApplication[] = useMemo(() => mergeSnapshots(snapshots), [snapshots]);

  const employmentTypes = useMemo(
    () => ["すべて", ...[...new Set(allApps.map((a) => a.employmentType))].sort((a, b) => a.localeCompare(b, "ja"))],
    [allApps]
  );

  /**
   * 集計の基準日。書き出した日を含む週が「直近週」になる。
   * これを渡さないと、週明けでまだ応募が無いだけで直近週が1つ前にズレ、
   * 「前週」として報告する数字が前々週のものになってしまう。
   */
  const asOf = useMemo(
    () => snapshots[snapshots.length - 1]?.takenAt,
    [snapshots]
  );

  /** 今期の初日。採用の期は9月始まりなので、8月までは前年の9/1になる。 */
  const termFrom = useMemo(() => {
    const base = (asOf ?? new Date().toISOString()).slice(0, 10);
    const y = Number(base.slice(0, 4));
    return `${Number(base.slice(5, 7)) >= 9 ? y : y - 1}-09-01`;
  }, [asOf]);

  /** 不足人数マスタに採用目標がある校舎。これ以外は既定で画面から外す。 */
  const masterKeys = useMemo(() => {
    if (!plan) return null;
    const keys = shortageByShop(plan)
      .filter((s) => s.shortage > 0)
      .map((s) => normalizeShopKey(s.shopShortName));
    return keys.length > 0 ? new Set(keys) : null;
  }, [plan]);

  /**
   * 雇用形態と対象校舎で絞った全期間の応募。充足（採用済み）の数え上げに使う。
   *
   * 既定でマスタ外の校舎を外すのは、採用目標を持っていない校舎（六本木オフィスなど）の
   * 応募や採用が混ざると、同じ画面のKPIと月次目標で母数が変わってしまうため。
   */
  const typedApps = useMemo(() => {
    const byType =
      employmentFilter === "すべて" ? allApps : allApps.filter((a) => a.employmentType === employmentFilter);
    if (scope === "all" || !masterKeys) return byType;
    return byType.filter((a) => masterKeys.has(normalizeShopKey(a.shopShortName)));
  }, [allApps, employmentFilter, scope, masterKeys]);

  /**
   * 画面に出す応募。既定では今期ぶんだけ。
   *
   * 全期間には2024年からの旧運用ぶん（ほぼ決着済み）が混ざっている。
   * 週次の棒グラフは9月以降しか出していないのに、ステータス内訳やファネルだけ
   * 2年ぶんの母数で出ると、同じ画面の中で数字が食い違って見える。
   */
  const apps = useMemo(
    () => (period === "term" ? typedApps.filter((a) => a.receivedDate >= termFrom) : typedApps),
    [typedApps, period, termFrom]
  );

  const trend = useMemo(() => weeklyTrend(apps), [apps]);
  const pool = useMemo(() => stagePool(apps), [apps]);
  const funnelSteps = useMemo(() => funnel(apps), [apps]);
  const weekKeys = useMemo(() => recentWeekKeys(apps, asOf), [apps, asOf]);
  const summary = useMemo(() => kpis(apps, weekKeys), [apps, weekKeys]);
  const rows = useMemo(() => breakdown(apps, dimension, weekKeys), [apps, dimension, weekKeys]);
  const matrix = useMemo(() => weeklyMatrix(apps, dimension, 12), [apps, dimension]);
  const reasons = useMemo(() => rejectReasons(apps), [apps]);

  const movements = useMemo(() => {
    if (snapshots.length < 2) return [];
    return statusMovements(allApps, snapshots[snapshots.length - 2].takenAt);
  }, [allApps, snapshots]);

  /** 採用目標から逆算した月次の応募目標と進捗 */
  const goals = useMemo(
    // 充足は「いつ応募した人でも採れていれば充足」なので、ここだけ全期間で見る
    () => monthlyGoals(typedApps, plan, rates, asOf, goalWindow ?? undefined),
    [typedApps, plan, rates, asOf, goalWindow]
  );

  const handleUploadApplications = useCallback(async (file: File) => {
    try {
      const snapshot = buildSnapshot(file.name, await readFile(file));
      if (snapshot.applications.length === 0) {
        setMessage({ kind: "error", text: "応募データを1件も読み取れませんでした。ジョブオプの応募エクスポートか確認してください。" });
        return;
      }
      await saveSnapshot({
        id: snapshot.id,
        takenAt: snapshot.takenAt,
        sourceFileName: snapshot.sourceFileName,
        applications: snapshot.applications,
      });
      setSnapshots(await listSnapshots());
      setMessage({
        kind: "info",
        text: `${snapshot.applications.length}件を取り込みました${snapshot.skipped > 0 ? `（${snapshot.skipped}行は応募IDか受付日が無いため除外）` : ""}。`,
      });
    } catch (e) {
      setMessage({ kind: "error", text: `取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  const handleUploadPlan = useCallback(async (file: File) => {
    try {
      const parsed = parsePlanFile(file.name, await readFile(file));
      if (parsed.rows.length === 0) {
        setMessage({ kind: "error", text: "不足人数マスタを読み取れませんでした。3列目が IT / D/W / C になっているか確認してください。" });
        return;
      }
      await savePlan(parsed);
      setPlan(parsed);
      setMessage({ kind: "info", text: `採用計画 ${parsed.rows.length}行（不足人数 計${totalShortage(parsed)}名）を取り込みました。` });
    } catch (e) {
      setMessage({ kind: "error", text: `取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  const handleImportBackup = useCallback(async (file: File) => {
    try {
      const backup = JSON.parse(await file.text());
      const result = await importBackup(backup);
      const [s, p] = await Promise.all([listSnapshots(), loadPlan()]);
      setSnapshots(s);
      setPlan(p);
      setMessage({ kind: "info", text: `${result.snapshots}件のスナップショットを復元しました。` });
    } catch (e) {
      setMessage({ kind: "error", text: `復元に失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  const handleExportBackup = useCallback(async () => {
    downloadJson(await exportBackup(), `採用モニタリング_バックアップ_${new Date().toISOString().slice(0, 10)}.json`);
  }, []);

  /**
   * 手元のデータを公開データとして上げる。
   *
   * 鍵は入れてもらったものをこのブラウザに覚えさせる。毎週聞かれると面倒なので。
   * 弾かれたときは覚えた鍵のほうを捨てて、次に入れ直せるようにする。
   */
  const handlePublish = useCallback(async () => {
    const stored = window.localStorage.getItem("shareKey") ?? "";
    const key = stored || window.prompt("公開用パスワードを入れてください") || "";
    if (!key) return;
    try {
      const result = await publishShared(await exportBackup(), key);
      window.localStorage.setItem("shareKey", key);
      await setSharedAt(result.publishedAt);
      setShared({ configured: true, publishedAt: result.publishedAt });
      setMessage({
        kind: "info",
        text: `公開データを更新しました（応募${result.applications}件）。これからURLを開く人には、この内容が出ます。`,
      });
    } catch (e) {
      window.localStorage.removeItem("shareKey");
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const handleExportWorkbook = useCallback(() => {
    downloadWorkbook(
      buildWorkbookSheets(apps, plan, rates, asOf),
      `採用モニタリング_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  }, [apps, plan, rates, asOf]);

  const handleDeleteSnapshot = useCallback(async (id: string) => {
    await deleteSnapshot(id);
    // 消したものが次に開いたときに初期データとして戻ってこないようにする
    await markSeedLoaded();
    setSnapshots(await listSnapshots());
  }, []);

  const handleResetPlan = useCallback(async () => {
    // 消すのは採用計画だけ。取り込み済みの応募スナップショットには触らない。
    await deletePlan();
    setPlan(null);
    setMessage({ kind: "info", text: "採用計画をクリアしました。応募データの履歴はそのままです。" });
  }, []);

  const lastWeekLabel = weekKeys.lastWeek?.label ?? "";

  /**
   * 直近週が何日ぶんなのか。定例が週の途中だと直近週は月〜水しか無く、
   * 前週と単純に比べると必ず減って見える。期間を明示して誤読を防ぐ。
   */
  const weekRangeNote = useMemo(() => {
    const { lastWeek, prevWeek } = weekKeys;
    if (!lastWeek || !prevWeek) return "";
    const prev = `前週 ${md(prevWeek.start)}〜${md(prevWeek.end)}`;
    if (!asOf) return `直近週 ${md(lastWeek.start)}〜${md(lastWeek.end)} ／ ${prev}`;
    const asOfDate = asOf.slice(0, 10);
    const days =
      Math.round(
        (new Date(`${asOfDate}T00:00:00`).getTime() - new Date(`${lastWeek.start}T00:00:00`).getTime()) / 86400000
      ) + 1;
    const partial = days < 7 ? `途中・${days}日ぶん` : "確定";
    return `直近週 ${md(lastWeek.start)}〜${md(asOfDate)}（${partial}） ／ ${prev}（確定）`;
  }, [weekKeys, asOf]);

  /**
   * 採用済み（充足ぶん）が何を数えているか。
   *
   * 上のKPIの「採用」とは母数が違う（KPIは集計期間ぶんの全校舎、こちらは期間を問わず
   * 不足人数マスタに載っている校舎だけ）。並べて見ると数が合わないので、ここで断っておく。
   */
  const hiredScopeNote = useMemo(() => {
    const t = goals.total;
    if (!t || t.alreadyHired === 0) return "採用済みは不足人数マスタに載っている校舎ぶんだけを数えています。";
    const j = (d: string) => d.slice(5).replace("-", "/");
    const span = t.hiredFrom && t.hiredTo ? `${j(t.hiredFrom)}〜${j(t.hiredTo)}に応募した人` : "全期間";
    return `採用済み${t.alreadyHired}名は、上の集計期間に関わらず全期間で数えています（いまは${span}）。上のKPIの採用${summary.hired}件は選んだ集計期間ぶんなので、期間を全期間にすると一致します。`;
  }, [goals, summary.hired]);

  /**
   * 集計している期間。ファネルなどが何を対象にしているかを示すのに使う。
   * 年を省くと2年ぶんの集計が5週ぶんに見えてしまうので、年まで出す。
   */
  const periodLabel = useMemo(() => {
    if (apps.length === 0) return "対象なし";
    const dates = apps.map((a) => a.receivedDate).sort();
    const j = (d: string) => d.replace(/-/g, "/");
    return `${j(dates[0])}〜${j(dates[dates.length - 1])}`;
  }, [apps]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:py-8">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          採用モニタリング
        </h1>
        <DataMenu
          snapshots={snapshots}
          plan={plan}
          onUploadApplications={handleUploadApplications}
          onUploadPlan={handleUploadPlan}
          onImportBackup={handleImportBackup}
          onExportBackup={handleExportBackup}
          onExportWorkbook={handleExportWorkbook}
          onPublish={handlePublish}
          sharedConfigured={shared.configured}
          sharedPublishedAt={shared.publishedAt}
          onDeleteSnapshot={handleDeleteSnapshot}
          onResetPlan={handleResetPlan}
        />
      </header>

      {message && (
        <p
          className="mb-4 rounded-lg px-3 py-2 text-xs leading-relaxed"
          style={{
            background: "var(--surface-1)",
            color: message.kind === "error" ? "var(--status-critical)" : "var(--text-secondary)",
          }}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          読み込み中…
        </p>
      ) : allApps.length === 0 ? (
        <EmptyState title="まだデータがありません">
          上の「応募データを取り込む」から、ジョブオプの応募エクスポート（.xls / .xlsx / .csv）を選んでください。
          毎週同じ操作をするたびにその週の断面が履歴として積み上がり、週次の推移が見られるようになります。
          データはこのブラウザの中に保存されるので、端末やブラウザを変えると引き継がれません。
          その場合は「バックアップ（.json）」で書き出したファイルを「バックアップを復元」から読み込んでください。
        </EmptyState>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {/* 絞り込みとセクション切り替え */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs" style={{ color: "var(--text-secondary)" }} htmlFor="employment-filter">
                雇用形態
              </label>
              <select
                id="employment-filter"
                value={employmentFilter}
                onChange={(e) => setEmploymentFilter(e.target.value)}
                className="rounded-lg border px-2 py-1.5 text-xs"
                style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
              >
                {employmentTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span className="hidden text-xs lg:inline" style={{ color: "var(--text-muted)" }}>
                正社員を扱い始めたら、ここで切り替えて同じ画面で見られます
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                集計期間
              </span>
              <div className="flex gap-1" role="group" aria-label="集計期間">
                {([
                  { key: "term" as Period, label: `今期（${termFrom.slice(0, 4)}/09〜）` },
                  { key: "all" as Period, label: "全期間" },
                ]).map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setPeriod(p.key)}
                    className="rounded-lg border px-2 py-1 text-xs"
                    style={{
                      borderColor: p.key === period ? "var(--series-1)" : "var(--hairline)",
                      color: p.key === period ? "var(--series-1)" : "var(--text-secondary)",
                      fontWeight: p.key === period ? 600 : 400,
                    }}
                    aria-pressed={p.key === period}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {period === "term"
                  ? `${periodLabel} の ${apps.length}件で集計しています（全期間では${typedApps.length}件）`
                  : `${periodLabel} の ${apps.length}件。2024年からの旧運用ぶんを含みます`}
              </span>
            </div>

            {masterKeys && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  対象の校舎
                </span>
                <div className="flex gap-1" role="group" aria-label="対象の校舎">
                  {([
                    { key: "master" as Scope, label: "不足人数マスタの校舎" },
                    { key: "all" as Scope, label: "全校舎" },
                  ]).map((o) => (
                    <button
                      key={o.key}
                      onClick={() => setScope(o.key)}
                      className="rounded-lg border px-2 py-1 text-xs"
                      style={{
                        borderColor: o.key === scope ? "var(--series-1)" : "var(--hairline)",
                        color: o.key === scope ? "var(--series-1)" : "var(--text-secondary)",
                        fontWeight: o.key === scope ? 600 : 400,
                      }}
                      aria-pressed={o.key === scope}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {scope === "master"
                    ? "採用目標を持っている校舎だけで集計しています。目標の無い校舎（六本木オフィスなど）の応募・採用は入りません"
                    : "採用目標の無い校舎も含めて集計しています。月次目標の採用済みとは母数が合いません"}
                </span>
              </div>
            )}

            {/* セクションタブはスマホ幅のときだけ。広い画面では全セクションを並べる。 */}
            <div
              className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:hidden"
              role="tablist"
              aria-label="表示するセクション"
            >
              {SECTIONS.map((s) => {
                const active = s.key === section;
                return (
                  <button
                    key={s.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSection(s.key)}
                    className="shrink-0 rounded-full border px-3 py-1.5 text-xs"
                    style={{
                      borderColor: active ? "var(--series-1)" : "var(--hairline)",
                      color: active ? "#ffffff" : "var(--text-secondary)",
                      background: active ? "var(--series-1)" : "transparent",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* サマリー */}
          <div className={`space-y-4 sm:space-y-5 ${section === "summary" ? "" : "hidden sm:block"}`}>
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-5">
              <StatTile
                label={`直近週の応募（${lastWeekLabel}）`}
                value={summary.lastWeekApplied}
                unit="件"
                delta={summary.wowDelta}
                deltaLabel="前週差"
                hint={weekRangeNote || undefined}
              />
              <StatTile label="4週平均の応募" value={summary.avg4w.toFixed(1)} unit="件/週" />
              <StatTile label="選考中プール" value={summary.activePool} unit="件" hint="未対応〜面接結果待ち" />
              <StatTile label="面接待ち" value={summary.interviewScheduled} unit="件" hint="日程確定済み" />
              <StatTile
                label="採用"
                value={summary.hired}
                unit="件"
                tone={summary.hired > 0 ? "good" : "neutral"}
                hint={`応募からの採用率 ${(summary.hireRate * 100).toFixed(1)}%${
                  goals.total ? ` ／ 月次目標の採用済み（全期間）は${goals.total.alreadyHired}名` : ""
                }`}
                className="col-span-2 lg:col-span-1"
              />
            </div>

            <Card
              title="週次の応募数"
              subtitle={
                period === "term"
                  ? "応募受付日ベース。今期（9月以降）の週だけを出しています。棒に触れるとその週の内訳が出ます。"
                  : "応募受付日ベース。全期間の週を出しています。棒に触れるとその週の内訳が出ます。"
              }
            >
              <WeeklyTrendChart points={trend} />
            </Card>

            <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
              <Card
                title="選考ステータスの内訳"
                subtitle={`${periodLabel}に応募した ${apps.length}件の、いまのステータス。棒の長さは群の中での比較です。`}
              >
                <StagePoolChart rows={pool} total={apps.length} />
              </Card>

              <Card title="通過ファネル" subtitle={`応募がどこで落ちているか（${periodLabel}の全応募 ${apps.length}件）`}>
                <FunnelChart steps={funnelSteps} />
              </Card>
            </div>
          </div>

          {/* 月次目標 */}
          <div className={`space-y-4 sm:space-y-5 ${section === "goal" ? "" : "hidden sm:block"}`}>
            {goals.rows.length > 0 ? (
              <Card
                title="月次の目標と進捗"
                subtitle={`残りの採用人数を月に1名ずつ割り当て、そこから歩留まりで割り戻した月ごとの目標と実績です。緊急${
                  goals.rows.filter((r) => r.urgent).length
                }校舎を先頭に並べています。${hiredScopeNote}`}
              >
                <div className="space-y-5">
                  <GoalControls rates={rates} onRates={setRates} goals={goals} onWindow={setGoalWindow} />
                  <MonthSummary goals={goals} />
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                        校舎ごと
                      </h3>
                      <MetricSwitch value={goalView} onChange={setGoalView} />
                    </div>
                    <MonthlyGoalTable goals={goals} view={goalView} />
                    <Coverage goals={goals} />
                  </div>
                  <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    各マスは「実績 / 目標」。当月は月末までの残りがあるので、経過ぶんに対する進み具合で色を付けています。
                    面接設定と採用は<strong>その月に応募した人を追いかけた数</strong>です（歩留まりは同じ人を追ったときの割合なので、
                    別の月に応募した人の面接を混ぜると想定値と比べられません）。
                    採用目標は<strong>残りの人数を月に1名ずつ</strong>置いています（残り3名なら3ヶ月に1名ずつ、
                    残り1名なら先頭の月だけ）。応募と面接設定はその月の採用目標から歩留まりで割り戻した数です。
                    半分以上過ぎた月からは期間を始めません（応募を集めて採用するまでに数週間かかるため）。
                    その月は「（実績）」として実績だけを並べます。目標も付けたいときは期間の開始月を変えてください。
                  </p>
                </div>
              </Card>
            ) : (
              <Card title="月次の目標と進捗">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {plan
                    ? "不足人数マスタに採用目標が1名以上入っている校舎がありません。"
                    : "不足人数マスタが未登録です。右上の「その他」から読み込むと、月ごとの応募目標が出ます。"}
                </p>
              </Card>
            )}
          </div>

          {/* 週次推移 */}
          <div className={`space-y-4 sm:space-y-5 ${section === "trend" ? "" : "hidden sm:block"}`}>
            <Card
              title={`${DIMENSION_LABEL[dimension]}ごとの週次推移`}
              subtitle="直近12週。色が濃いほど応募が多い週です。"
              actions={<DimensionSwitch value={dimension} onChange={setDimension} />}
            >
              <WeeklyMatrixTable matrix={matrix} dimensionLabel={DIMENSION_LABEL[dimension]} />
            </Card>
          </div>

          {/* 選考状況 */}
          <div className={`space-y-4 sm:space-y-5 ${section === "breakdown" ? "" : "hidden sm:block"}`}>
            <Card
              title={`${DIMENSION_LABEL[dimension]}ごとの選考状況`}
              subtitle={`累計と直近週、そして選考のどこまで進んでいるか。${weekRangeNote}`}
              // 週次推移と離れた位置に来るので、ここでも軸を切り替えられるようにする（状態は共通）
              actions={<DimensionSwitch value={dimension} onChange={setDimension} />}
            >
              <BreakdownTable rows={rows} dimensionLabel={DIMENSION_LABEL[dimension]} />
            </Card>
          </div>

          {/* 動き */}
          <div className={`space-y-4 sm:space-y-5 ${section === "activity" ? "" : "hidden sm:block"}`}>
            {movements.length > 0 && (
              <Card title="前回取り込み以降に動いた選考" subtitle={`${movements.length}件のステータスが変わりました`}>
                <ul className="space-y-1.5">
                  {movements.slice(0, 30).map((m) => (
                    <li key={m.app.applicationId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span style={{ color: "var(--text-primary)" }}>{m.app.shopShortName}</span>
                      <span style={{ color: "var(--text-muted)" }}>{m.app.receivedDate} 応募</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {m.from} → <strong style={{ color: "var(--text-primary)" }}>{m.to}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {reasons.length > 0 && (
              <Card title="不採用・辞退の理由" subtitle="どこで取りこぼしているかの手掛かり">
                <ul className="space-y-1">
                  {reasons.map((r) => (
                    <li key={r.reason} className="flex justify-between gap-3 text-xs">
                      <span style={{ color: "var(--text-primary)" }}>{r.reason}</span>
                      <span className="tabular" style={{ color: "var(--text-secondary)" }}>
                        {r.count}件
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card title="凡例">
              <Legend items={pool.map((p) => ({ label: p.label, color: p.color }))} />
              <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                「選考中プール」は 未対応・面接調整中・面接待ち・面接結果待ち の合計です。
                「面接設定」は面接日が確定した以降（面接前の不採用・辞退は含みません）、
                「面接実施」は面接結果待ち以降を指します。
                <br />
                「充足率」は、不足人数マスタの採用目標に対して採用まで至った人数の割合です。
              </p>
              <div className="mt-3">
                <Button onClick={handleExportWorkbook}>この内容をスプレッドシートに書き出す</Button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}
