"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HiringPlan, MergedApplication, Snapshot } from "@/types/recruiting";
import { buildSnapshot } from "@/lib/recruiting/parse";
import { mergeSnapshots } from "@/lib/recruiting/merge";
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
  weeklyHires,
  weeklyTrend,
} from "@/lib/recruiting/aggregate";
import { parsePlanFile, shortageByShop, totalShortage } from "@/lib/recruiting/plan";
import { FUNNEL_STEPS, stageOf } from "@/lib/recruiting/status";
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
  loadGoalWindow,
  loadHrSheet,
  loadPlan,
  loadProjectStart,
  saveGoalWindow,
  saveHrSheet,
  savePlan,
  saveProjectStart,
  saveSnapshot,
  setSharedAt,
} from "@/lib/recruiting/storage";
import { fetchShared, publishShared } from "@/lib/recruiting/shared";
import { ExternalSource, fetchExternalSource } from "@/lib/recruiting/source";
import { Button, Card, EmptyState, Legend, Modal, StatTile } from "@/components/dashboard/ui";
import { FunnelChart, StagePoolChart, WEEKLY_SERIES_COLORS, WeeklyTrendChart } from "@/components/dashboard/charts";
import { BreakdownTable, WeeklyMatrixTable } from "@/components/dashboard/tables";
import { DataMenu } from "@/components/dashboard/DataPanel";
import { HrSheet, compareWithJobop, crossTab, parseHrSheet } from "@/lib/recruiting/hrsheet";
import { HrCategoryNote, HrCompareTable, HrCrossTable } from "@/components/dashboard/hrsheet";
import { DEFAULT_RATES, GoalRates, GoalWindow, monthlyGoals } from "@/lib/recruiting/goal";
import {
  Coverage,
  GoalControls,
  GoalFacts,
  GoalView,
  MetricSwitch,
  MonthSummary,
  MonthlyGoalTable,
} from "@/components/dashboard/goals";

type Message = { kind: "info" | "error"; text: string } | null;

/**
 * 数字の定義。経営会議に出す数字なので、何をどう数えているかを画面から辿れるようにしておく。
 * ただし常時出しておくと本題が埋もれるので、右上のボタンから開く。
 */
const DEFINITIONS: [string, string][] = [
  ["対象の校舎", "不足人数マスタに採用目標が1名以上ある校舎だけ（既定）。六本木オフィスなど目標の無い拠点は入りません。"],
  [
    "集計期間",
    "既定は施策開始（2026/07/23）から。応募は応募受付日、採用と面接は選考ステータス最終更新日で期間を判定します。",
  ],
  [
    "採用",
    "その期間に採用が決まった人数（応募がいつかは問いません）。採用タイル・週次グラフの緑・月次目標の採用済みは、すべてこの数です。",
  ],
  [
    "採用が決まった日",
    "ジョブオプに採用日の項目が無いため、選考ステータス最終更新日を使っています。まとめてステータスを更新すると、前に決まっていた人もその日の採用として立ちます。週ごとの山が不自然なときは、書き出しの「採用明細」で日付を確かめてください。",
  ],
  [
    "通過ファネルの採用",
    "その期間に応募した人を追いかけて、そこから採れた数です。上の採用とは数え方が違います（どちらも正しく、見ているものが違います）。",
  ],
  [
    "充足・残り",
    "充足は校舎の採用目標までで頭打ち。残り＝目標−充足。目標より多く採れたぶんは他の校舎の不足を埋めないので、残りからは引きません。",
  ],
  [
    "必要応募",
    "残りの人数 ÷（応募→面接率 × 面接→採用率）を校舎ごとに1回だけ切り上げた数。既定の30%×60%なら1名採るのに5.6件。",
  ],
  ["4週平均の応募", "確定した直近4週の平均。集計途中の週は入れません。"],
  [
    "Excel集計のコース",
    "採用チームの採用管理表から、校舎 × コースで数えた表です。IT と CAD だけを拾い、それ以外は デザイン・Web、分野が空欄の行は 未記入 に分けています。",
  ],
];

const DIMENSIONS: Dimension[] = ["shopShortName", "employmentType", "media", "route", "jobTitle"];

type SectionKey = "summary" | "goal" | "trend" | "breakdown" | "excel";

/** 2026-09-21 → 9/21 */
const md = (d?: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");

/** 並びは画面の上から下と同じ。スマホのタブもこの順で出る。 */
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "summary", label: "サマリー" },
  { key: "goal", label: "月次目標" },
  { key: "trend", label: "週次推移" },
  { key: "breakdown", label: "選考状況" },
  { key: "excel", label: "Excel集計" },
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

/**
 * 集計期間の選択肢。
 * project＝施策の開始日から（既定）。term＝今期（9月始まりの採用期）。all＝全期間。
 */
type Period = "project" | "term" | "all";

/** 施策の開始日の既定値。求人を出し直した日。 */
const DEFAULT_PROJECT_START = "2026-07-23";

/** 対象の校舎。master＝不足人数マスタに採用目標がある校舎だけ。 */
type Scope = "master" | "all";

function readFile(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export default function DashboardPage() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [plan, setPlan] = useState<HiringPlan | null>(null);
  // 採用チームが作っている採用管理表（Excel）。コース別の集計に使う。
  const [hrSheet, setHrSheet] = useState<HrSheet | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [loading, setLoading] = useState(true);
  const [dimension, setDimension] = useState<Dimension>("shopShortName");
  const [employmentFilter, setEmploymentFilter] = useState<string>("すべて");
  // 校舎の絞り込み。1校舎だけを見たいときに使う。
  const [shopFilter, setShopFilter] = useState<string>("すべて");
  // スマホでは縦に長くなりすぎるのでセクションを切り替える。画面が広いときは全部並べる。
  const [section, setSection] = useState<SectionKey>("summary");
  // 数字の定義と凡例。画面に常時置くと情報が多すぎるので、押したときだけ出す。
  const [showGuide, setShowGuide] = useState(false);
  // 公開データ（サーバーに置いてある共有データ）の状態。
  // configured が false のときは保存先が未設定で、同梱データだけで動いている。
  const [shared, setShared] = useState<{ configured: boolean; publishedAt: string | null }>({
    configured: false,
    publishedAt: null,
  });
  // 人事チームのExcel（SharePoint / OneDrive）から直接読んだ結果
  const [source, setSource] = useState<ExternalSource | null>(null);
  const [syncing, setSyncing] = useState(false);
  // 集計期間。既定は今期（9月始まり）。全期間は旧運用ぶんも含めて見たいときだけ。
  const [period, setPeriod] = useState<Period>("project");
  const [projectStart, setProjectStart] = useState(DEFAULT_PROJECT_START);
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
        const [s, p, w, start, hr] = await Promise.all([
          listSnapshots(),
          loadPlan(),
          loadGoalWindow(),
          loadProjectStart(),
          loadHrSheet(),
        ]);
        setSnapshots(s);
        setPlan(p);
        setHrSheet(hr);
        // 一度選んだ按分期間は覚えておく。開くたびに目標が割り直されると計画にならない。
        if (w) setGoalWindow(w);
        if (start) setProjectStart(start);

        // 人事チームのExcelが設定されていれば、開いた時点で読みに行く
        void syncExternal(true);
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

  /**
   * 集計の起点。応募も採用もこの日から数える。
   *
   * 応募だけ9月から、採用は7月に応募した人も含む、という状態だと母数が揃わず、
   * 採用率も予実も比べられない。1本の日付で切る。
   */
  const periodFrom = useMemo(
    () => (period === "project" ? projectStart : period === "term" ? termFrom : null),
    [period, projectStart, termFrom]
  );

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
    let out =
      employmentFilter === "すべて" ? allApps : allApps.filter((a) => a.employmentType === employmentFilter);
    if (scope !== "all" && masterKeys) out = out.filter((a) => masterKeys.has(normalizeShopKey(a.shopShortName)));
    if (shopFilter !== "すべて") {
      const key = normalizeShopKey(shopFilter);
      out = out.filter((a) => normalizeShopKey(a.shopShortName) === key);
    }
    return out;
  }, [allApps, employmentFilter, scope, masterKeys, shopFilter]);

  /** 校舎の選択肢。応募がある校舎と、採用目標がある校舎の両方を並べる。 */
  const shopOptions = useMemo(() => {
    const names = new Set<string>();
    for (const a of allApps) names.add(a.shopShortName);
    if (plan) for (const s of shortageByShop(plan).filter((x) => x.shortage > 0)) names.add(s.shopShortName);
    return ["すべて", ...[...names].sort((a, b) => a.localeCompare(b, "ja"))];
  }, [allApps, plan]);

  /**
   * 画面に出す応募。既定では今期ぶんだけ。
   *
   * 全期間には2024年からの旧運用ぶん（ほぼ決着済み）が混ざっている。
   * 週次の棒グラフは9月以降しか出していないのに、ステータス内訳やファネルだけ
   * 2年ぶんの母数で出ると、同じ画面の中で数字が食い違って見える。
   */
  const apps = useMemo(
    () => (periodFrom ? typedApps.filter((a) => a.receivedDate >= periodFrom) : typedApps),
    [typedApps, periodFrom]
  );

  /**
   * 「その期間に起きたこと」で数える採用と面接。
   *
   * 応募は応募日で絞るが、採用は応募がいつかに関わらず、採用が決まった日で絞る。
   * 「9月に何名採ったか」を、9月に応募した人だけで数えると実態と合わないため。
   * 日付はジョブオプの選考ステータス最終更新日を使う（採用はそこで止まるので、
   * 更新日＝決まった日になる）。
   */
  const movedOn = useCallback((a: MergedApplication) => (a.statusUpdatedAt ?? a.receivedAt).slice(0, 10), []);
  const inPeriod = useCallback((date: string) => !periodFrom || date >= periodFrom, [periodFrom]);
  const hires = useMemo(
    () => typedApps.filter((a) => stageOf(a.statusId) === "hired" && inPeriod(movedOn(a))),
    [typedApps, inPeriod, movedOn]
  );
  const interviews = useMemo(
    () => typedApps.filter((a) => FUNNEL_STEPS[1].reached(stageOf(a.statusId)) && inPeriod(movedOn(a))),
    [typedApps, inPeriod, movedOn]
  );

  /** 校舎で絞る前の、期間だけ合わせた応募。マスタ外が何件あるかを出すのに使う。 */
  const periodApps = useMemo(() => {
    const byType =
      employmentFilter === "すべて" ? allApps : allApps.filter((a) => a.employmentType === employmentFilter);
    return periodFrom ? byType.filter((a) => a.receivedDate >= periodFrom) : byType;
  }, [allApps, employmentFilter, periodFrom]);

  /**
   * 週次の応募数。
   *
   * 期の初日が週の途中だと、先頭の棒は「8/31週」と書いてあるのに
   * 9/1以降しか数えていない、という読み違いが起きる。ラベルと範囲を実態に合わせる。
   */
  const trend = useMemo(() => {
    const points = weeklyTrend(apps);
    const first = points[0];
    if (!periodFrom || !first || first.week.start >= periodFrom) return points;
    const [, m, d] = periodFrom.split("-");
    return [
      { ...first, week: { ...first.week, start: termFrom, label: `${Number(m)}/${Number(d)}週` } },
      ...points.slice(1),
    ];
  }, [apps, periodFrom]);
  /**
   * 週ごとの採用数。応募グラフと同じ週の並びに、採用が決まった週で数えた人数を重ねる。
   * 期間で絞る前の応募から数えるのは、8月に応募して9月に決まった人を落とさないため。
   */
  const hireTrend = useMemo(() => weeklyHires(hires, trend.map((p) => p.week)), [hires, trend]);
  const pool = useMemo(() => stagePool(apps), [apps]);
  const funnelSteps = useMemo(() => funnel(apps), [apps]);
  const weekKeys = useMemo(() => recentWeekKeys(apps, asOf), [apps, asOf]);
  const summary = useMemo(() => kpis(apps, weekKeys, asOf), [apps, weekKeys, asOf]);
  const rows = useMemo(() => breakdown(apps, dimension, weekKeys), [apps, dimension, weekKeys]);
  const matrix = useMemo(() => weeklyMatrix(apps, dimension, 12), [apps, dimension]);
  const reasons = useMemo(() => rejectReasons(apps), [apps]);

  /** 採用目標から逆算した月次の応募目標と進捗 */
  const goals = useMemo(
    // 採用済みも画面の集計期間に合わせる。ここだけ全期間にしていたせいで、
    // KPIの採用と月次目標の採用済みが別の数字になって読めなくなっていた。
    () =>
      monthlyGoals(apps, plan, rates, asOf, goalWindow ?? undefined, periodApps, { hires, interviews }, periodFrom?.slice(0, 7)),
    [apps, plan, rates, asOf, goalWindow, periodApps, hires, interviews, periodFrom]
  );

  /**
   * 採用管理表（Excel）の集計。校舎 × コース。
   * 期間の起点は画面の集計期間に合わせる（応募日で切る）。
   */
  const hrCross = useMemo(() => {
    if (!hrSheet) return null;
    const shopKey = shopFilter === "すべて" ? null : normalizeShopKey(shopFilter);
    return crossTab(hrSheet, {
      from: periodFrom,
      // 画面の絞り込みと同じ条件で切る。ここだけ全校舎にすると、隣に並べたジョブオプ側と母数が変わる。
      include: (key) =>
        (shopKey ? key === shopKey : true) && (scope === "all" || !masterKeys || masterKeys.has(key)),
    });
  }, [hrSheet, periodFrom, shopFilter, scope, masterKeys]);

  /** ジョブオプ側の校舎ごとの採用数。Excelとの差を出すのに使う。 */
  const jobopByShop = useMemo(() => {
    const out = new Map<string, number>();
    for (const a of hires) {
      const key = normalizeShopKey(a.shopShortName);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  }, [hires]);

  const hrCompare = useMemo(
    () => (hrCross ? compareWithJobop(hrCross, jobopByShop) : []),
    [hrCross, jobopByShop]
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

  /**
   * 採用チームの採用管理表（Excel）を取り込む。
   *
   * ジョブオプのエクスポートには分野（コース）が入っていないので、校舎ごとの人数までしか出せない。
   * こちらのシートには分野が入っているので、校舎 × コースで数えられる。
   * 人が手で付けている表なので数字はジョブオプ側と一致しないことがあり、置き換えずに別タブで並べる。
   */
  const handleUploadHrSheet = useCallback(async (file: File) => {
    try {
      const sheet = parseHrSheet(file.name, await readFile(file));
      if (sheet.rows.length === 0) {
        setMessage({
          kind: "error",
          text: "採用管理表を読み取れませんでした。「元データ」シートに スクール / ステータス / 分野 の列があるか確認してください。",
        });
        return;
      }
      await saveHrSheet(sheet);
      setHrSheet(sheet);
      setSection("excel");
      setMessage({
        kind: "info",
        text: `採用管理表から${sheet.rows.length}行を取り込みました（採用${sheet.rows.filter((r) => r.hired).length}名）。「Excel集計」に出ます。`,
      });
    } catch (e) {
      setMessage({ kind: "error", text: `取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  const handleImportBackup = useCallback(async (file: File) => {
    try {
      const backup = JSON.parse(await file.text());
      const result = await importBackup(backup);
      const [s, p, hr] = await Promise.all([listSnapshots(), loadPlan(), loadHrSheet()]);
      setSnapshots(s);
      setPlan(p);
      setHrSheet(hr);
      setMessage({ kind: "info", text: `${result.snapshots}件のスナップショットを復元しました。` });
    } catch (e) {
      setMessage({ kind: "error", text: `復元に失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  /**
   * 人事チームのExcelを読み込む。
   *
   * 不足人数マスタなら計画として、応募エクスポートならスナップショットとして取り込む。
   * 画面を開くたびに走らせるので、Excel側が更新されていればそのまま反映される。
   */
  const syncExternal = useCallback(async (quiet: boolean) => {
    setSyncing(true);
    try {
      const got = await fetchExternalSource();
      setSource(got);
      if (!got?.configured) return;
      if (got.error) {
        if (!quiet) setMessage({ kind: "error", text: `Excelを読めませんでした: ${got.error}` });
        return;
      }

      if (got.snapshot) {
        await saveSnapshot(got.snapshot);
        setSnapshots(await listSnapshots());
        if (!quiet) {
          setMessage({ kind: "info", text: `Excelから応募${got.snapshot.applications.length}件を読み込みました。` });
        }
      } else if (got.plan) {
        await savePlan(got.plan);
        setPlan(got.plan);
        if (!quiet) {
          setMessage({
            kind: "info",
            text: `Excelから採用計画 ${got.plan.rows.length}行（不足人数 計${totalShortage(got.plan)}名）を読み込みました。`,
          });
        }
      }
    } catch (e) {
      if (!quiet) setMessage({ kind: "error", text: `Excelの取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSyncing(false);
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
      buildWorkbookSheets(apps, plan, rates, asOf, allApps),
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

  /** 直近週と前週の期間。1行に詰めると読めないので2行に分ける。 */
  const weekRangeLines = useMemo(() => {
    const { lastWeek, prevWeek } = weekKeys;
    if (!lastWeek || !prevWeek) return undefined;
    const asOfDate = asOf?.slice(0, 10);
    const days = asOfDate
      ? Math.round(
          (new Date(`${asOfDate}T00:00:00`).getTime() - new Date(`${lastWeek.start}T00:00:00`).getTime()) / 86400000
        ) + 1
      : 7;
    const end = asOfDate ?? lastWeek.end;
    return [
      `今週 ${md(lastWeek.start)}〜${md(end)}${days < 7 ? `（${days}日ぶん・集計中）` : "（確定）"}`,
      `前週 ${md(prevWeek.start)}〜${md(prevWeek.end)}（確定）`,
    ];
  }, [weekKeys, asOf]);

  /** 4週平均が、いつからいつまでの4週なのか。 */
  const avg4wNote = useMemo(() => {
    const settled = asOf ? trend.filter((p) => p.week.end <= asOf.slice(0, 10)) : trend;
    const last4 = settled.slice(-4);
    if (last4.length === 0) return "";
    return `確定した直近${last4.length}週（${md(last4[0].week.start)}〜${md(last4[last4.length - 1].week.end)}）の平均`;
  }, [trend, asOf]);

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
        {source?.configured && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span style={{ color: "var(--text-muted)" }}>
              {source.error
                ? `Excel連携エラー：${source.error}`
                : `人事チームのExcelから自動取得（${source.fileName ?? ""}${
                    source.lastModified ? ` / 更新 ${md(source.lastModified.slice(0, 10))}` : ""
                  }）`}
            </span>
            <Button onClick={() => void syncExternal(false)} disabled={syncing}>
              {syncing ? "取得中…" : "最新に更新"}
            </Button>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Button onClick={() => setShowGuide(true)}>前提情報</Button>
        </div>
        <DataMenu
          snapshots={snapshots}
          plan={plan}
          onUploadApplications={handleUploadApplications}
          onUploadPlan={handleUploadPlan}
          onUploadHrSheet={handleUploadHrSheet}
          hrSheetInfo={
            hrSheet
              ? { sourceFileName: hrSheet.sourceFileName, importedAt: hrSheet.importedAt, rows: hrSheet.rows.length }
              : null
          }
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
              <label className="text-xs" style={{ color: "var(--text-secondary)" }} htmlFor="shop-filter">
                校舎
              </label>
              <select
                id="shop-filter"
                value={shopFilter}
                onChange={(e) => setShopFilter(e.target.value)}
                className="max-w-[12rem] rounded-lg border px-2 py-1.5 text-xs"
                style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--text-primary)" }}
              >
                {shopOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {shopFilter !== "すべて" && (
                <button
                  onClick={() => setShopFilter("すべて")}
                  className="rounded-lg border px-2 py-1 text-xs"
                  style={{ borderColor: "var(--hairline)", color: "var(--text-secondary)" }}
                >
                  絞り込みを外す
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                集計期間
              </span>
              <div className="flex gap-1" role="group" aria-label="集計期間">
                {([
                  { key: "project" as Period, label: `施策開始から（${projectStart.slice(5).replace("-", "/")}〜）` },
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
              {period === "project" && (
                <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                  開始日
                  <input
                    type="date"
                    value={projectStart}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      setProjectStart(v);
                      void saveProjectStart(v);
                    }}
                    className="rounded border px-1.5 py-0.5 text-xs"
                    style={{ borderColor: "var(--gridline)", background: "var(--background)", color: "var(--text-primary)" }}
                  />
                </label>
              )}
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {period === "all"
                  ? `${periodLabel} の ${apps.length}件。2024年からの旧運用ぶんを含みます`
                  : `${periodLabel} の ${apps.length}件で集計しています（全期間では${typedApps.length}件）。応募も採用も同じ起点で数えています`}
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
                hint={weekRangeLines}
              />
              <StatTile
                label="4週平均の応募"
                value={summary.avg4w.toFixed(1)}
                unit="件/週"
                hint={avg4wNote ? [avg4wNote] : undefined}
              />
              <StatTile label="選考中プール" value={summary.activePool} unit="件" hint="未対応〜面接結果待ち" />
              <StatTile label="面接待ち" value={summary.interviewScheduled} unit="件" hint="日程確定済み" />
              <StatTile
                label="採用"
                value={hires.length}
                unit="名"
                tone={hires.length > 0 ? "good" : "neutral"}
                hint={[
                  "この期間に決まった採用",
                  `同じ期間の応募${apps.length}件に対して ${
                    apps.length > 0 ? ((hires.length / apps.length) * 100).toFixed(1) : "0.0"
                  }%`,
                ]}
                className="col-span-2 lg:col-span-1"
              />
            </div>

            <Card
              title="週次の応募数と採用数"
              subtitle={`青は応募した週、緑は採用が決まった週で数えています（採用は応募がいつかを問いません）。同じ週の青と緑は別の人なので対応しません。緑の合計 ${hireTrend.reduce(
                (a, p) => a + p.hired,
                0
              )}名は、上の採用タイルとも月次目標の採用実績とも同じ数字です。`}
              actions={
                <Legend
                  items={[
                    { label: "応募", color: WEEKLY_SERIES_COLORS.applied },
                    { label: "採用（決まった週）", color: WEEKLY_SERIES_COLORS.hired },
                  ]}
                />
              }
            >
              <WeeklyTrendChart points={trend} hires={hireTrend} />
            </Card>

            <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
              <Card
                title="選考ステータスの内訳"
                subtitle={`${periodLabel}に応募した ${apps.length}件の、いまのステータス。棒の長さは群の中での比較です。`}
              >
                <StagePoolChart rows={pool} total={apps.length} />
              </Card>

              <Card
                title="通過ファネル"
                subtitle={`${periodLabel}に応募した ${apps.length}件を追いかけた結果です。採用${
                  funnelSteps[3]?.count ?? 0
                }件は「この応募の中から採れた数」なので、その期間に決まった採用${hires.length}名とは別の数え方です。`}
              >
                <FunnelChart steps={funnelSteps} />
              </Card>
            </div>
          </div>

          {/* 月次目標 */}
          <div className={`space-y-4 sm:space-y-5 ${section === "goal" ? "" : "hidden sm:block"}`}>
            {goals.rows.length > 0 ? (
              <Card
                title="月次の目標と進捗"
                subtitle={`残りの採用人数を月に配り、歩留まりで割り戻した目標と実績です。緊急${
                  goals.rows.filter((r) => r.urgent).length
                }校舎を先頭に並べています。`}
              >
                <div className="space-y-5">
                  <GoalFacts goals={goals} rates={rates} />
                  <GoalControls
                    rates={rates}
                    onRates={setRates}
                    goals={goals}
                    onWindow={(w) => {
                      setGoalWindow(w);
                      void saveGoalWindow(w);
                    }}
                  />
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
              subtitle="直近12週まで。色が濃いほど応募が多い週です。右端の計は、この表に出ている週ぶんの合計です（集計期間がこれより長いときは、下の選考状況の応募数と一致しません）。"
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
          </div>

          {/* Excel集計（採用チームの採用管理表） */}
          <div className={`space-y-4 sm:space-y-5 ${section === "excel" ? "" : "hidden sm:block"}`}>
            {hrCross ? (
              <>
                <Card
                  title="校舎 × コースの採用人数（採用チームのExcel）"
                  subtitle="コースは 不足人数マスタと同じ IT / デザイン・Web / CAD と、Excel側で分野が空欄の 未記入 の4列です。見出しを押すと並び替わります。"
                >
                  <div className="space-y-4">
                    <ul className="space-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                      <li>
                        採用（ステータス「合格」）<strong style={{ color: "var(--text-primary)" }}>{hrCross.total}名</strong>
                        ／ 応募 {hrCross.totalApplied}件（採用率 {hrCross.totalApplied > 0 ? ((hrCross.total / hrCross.totalApplied) * 100).toFixed(1) : "0.0"}%）
                      </li>
                      <li>
                        同じ絞り込みのジョブオプ側は{" "}
                        <strong style={{ color: "var(--text-primary)" }}>{hires.length}名</strong>
                        （差 {hrCross.total - hires.length > 0 ? "+" : ""}
                        {hrCross.total - hires.length}名）
                      </li>
                      <li>
                        {periodFrom ? `${periodFrom.replace(/-/g, "/")}以降の応募` : "全期間の応募"}
                        {hrCross.excluded > 0 ? ` ／ 期間・対象校舎の条件で${hrCross.excluded}行を除外` : ""}
                      </li>
                      <li>
                        取り込み {hrSheet ? `${hrSheet.rows.length}行（${hrSheet.sourceFileName}）` : ""}
                      </li>
                    </ul>
                    <HrCrossTable cross={hrCross} />
                    <HrCategoryNote cross={hrCross} />
                  </div>
                </Card>

                <Card
                  title="ジョブオプとの差（校舎ごとの採用数）"
                  subtitle="置き換えずに並べています。どちらが正しいかはこの画面では決められないので、差が大きい校舎から確認してください。"
                >
                  <div className="space-y-4">
                    <HrCompareTable rows={hrCompare} />
                    <ul className="space-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
                      <li>Excel … ステータスが「合格」の人数。採用チームが手で付けています。</li>
                      <li>ジョブオプ … 選考ステータスが「採用」で、その更新日が期間内の人数。</li>
                      <li>差が出る主な理由 … 判断を入れたタイミングのずれ、どちらかに入力が無い、校舎名の書き方の違い。</li>
                      <li>
                        コースは IT と CAD だけを拾い、<strong>それ以外（WEBDTP・WEB・DTP・映像など）は デザイン・Web</strong>
                        に寄せています。分野が空欄の行は寄せずに <strong>未記入</strong> の列に分けています。
                      </li>
                    </ul>
                  </div>
                </Card>
              </>
            ) : (
              <Card title="Excel集計（採用チームの採用管理表）">
                <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  右上の「その他」→「採用管理表（Excel）を取り込む」から、採用チームの管理表（.xlsx）を選んでください。
                  「元データ」シートの スクール / 分野 / ステータス / 応募日時 だけを読み、校舎 × コースの採用人数を出します。
                  氏名・年齢・性別は読み取りません。
                </p>
              </Card>
            )}
          </div>

        </div>
      )}

      <Modal title="前提情報（数字の定義と凡例）" open={showGuide} onClose={() => setShowGuide(false)}>
        <div className="space-y-5">
          <dl className="space-y-2.5 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {DEFINITIONS.map(([term, body]) => (
              <div key={term}>
                <dt className="font-semibold" style={{ color: "var(--text-primary)" }}>
                  {term}
                </dt>
                <dd>{body}</dd>
              </div>
            ))}
          </dl>

          <div className="border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
            <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
              凡例
            </h3>
            <Legend items={pool.map((p) => ({ label: p.label, color: p.color }))} />
            <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              「選考中プール」は 未対応・面接調整中・面接待ち・面接結果待ち の合計です。
              「面接設定」は面接日が確定した以降（面接前の不採用・辞退は含みません）、
              「面接実施」は面接結果待ち以降を指します。
              <br />
              「充足率」は、不足人数マスタの採用目標に対して採用まで至った人数の割合です。
            </p>
          </div>

          <p className="border-t pt-4 text-xs leading-relaxed" style={{ borderColor: "var(--gridline)", color: "var(--text-muted)" }}>
            定義を変えるときは、画面を変える前に共有します。詳しい計算方法と変更履歴は docs/metrics.md にあります。
          </p>
        </div>
      </Modal>
    </main>
  );
}
