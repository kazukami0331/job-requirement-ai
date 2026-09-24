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
import { parsePlanFile, shortageLookup, totalShortage } from "@/lib/recruiting/plan";
import { normalizeShopKey } from "@/lib/recruiting/shops";
import { ACTIVE_STAGES, FUNNEL_STEPS, stageOf } from "@/lib/recruiting/status";
import { weekOfIso } from "@/lib/recruiting/week";
import { buildWorkbookSheets, downloadJson, downloadWorkbook } from "@/lib/recruiting/export";
import {
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
} from "@/lib/recruiting/storage";
import { Button, Card, EmptyState, Legend, StatTile } from "@/components/dashboard/ui";
import { FunnelChart, StagePoolChart, WeeklyTrendChart } from "@/components/dashboard/charts";
import { BreakdownTable, PlanVsActualRow, PlanVsActualTable, WeeklyMatrixTable } from "@/components/dashboard/tables";
import { DataMenu } from "@/components/dashboard/DataPanel";

type Message = { kind: "info" | "error"; text: string } | null;

const DIMENSIONS: Dimension[] = ["shopShortName", "employmentType", "media", "route", "jobTitle"];

type SectionKey = "summary" | "shops" | "plan" | "activity";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "summary", label: "サマリー" },
  { key: "plan", label: "充足状況" },
  { key: "shops", label: "校舎別応募" },
  { key: "activity", label: "動き" },
];

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

  useEffect(() => {
    (async () => {
      try {
        // 保存先がブラウザごとなので、初回は同梱してある受領済みデータを入れる
        const seeded = await loadSeedIfEmpty();
        const [s, p] = await Promise.all([listSnapshots(), loadPlan()]);
        setSnapshots(s);
        setPlan(p);
        if (seeded) {
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

  const apps = useMemo(
    () => (employmentFilter === "すべて" ? allApps : allApps.filter((a) => a.employmentType === employmentFilter)),
    [allApps, employmentFilter]
  );

  const trend = useMemo(() => weeklyTrend(apps), [apps]);
  const pool = useMemo(() => stagePool(apps), [apps]);
  const funnelSteps = useMemo(() => funnel(apps), [apps]);
  const summary = useMemo(() => kpis(apps), [apps]);
  const weekKeys = useMemo(() => recentWeekKeys(apps), [apps]);
  const rows = useMemo(() => breakdown(apps, dimension, weekKeys), [apps, dimension, weekKeys]);
  const matrix = useMemo(() => weeklyMatrix(apps, dimension, 12), [apps, dimension]);
  const reasons = useMemo(() => rejectReasons(apps), [apps]);

  const movements = useMemo(() => {
    if (snapshots.length < 2) return [];
    return statusMovements(allApps, snapshots[snapshots.length - 2].takenAt);
  }, [allApps, snapshots]);

  /** 不足人数と応募実績の突合 */
  const planVsActual: PlanVsActualRow[] = useMemo(() => {
    if (!plan) return [];
    const lookup = shortageLookup(plan);
    type Actual = {
      applied: number;
      lastWeekApplied: number;
      prevWeekApplied: number;
      pool: number;
      scheduled: number;
      hired: number;
    };
    const actual = new Map<string, Actual>();

    for (const a of apps) {
      const key = normalizeShopKey(a.shopShortName);
      const e: Actual =
        actual.get(key) ?? { applied: 0, lastWeekApplied: 0, prevWeekApplied: 0, pool: 0, scheduled: 0, hired: 0 };
      const stage = stageOf(a.statusId);
      e.applied++;
      if (ACTIVE_STAGES.includes(stage)) e.pool++;
      // 面接日が確定した、もしくはその先に進んだもの（面接前の不採用・辞退は含めない）
      if (FUNNEL_STEPS[1].reached(stage)) e.scheduled++;
      if (stage === "hired") e.hired++;

      const wk = weekOfIso(a.receivedAt).key;
      if (weekKeys.lastWeekKey && wk === weekKeys.lastWeekKey) e.lastWeekApplied++;
      if (weekKeys.prevWeekKey && wk === weekKeys.prevWeekKey) e.prevWeekApplied++;

      actual.set(key, e);
    }

    return [...lookup.entries()]
      .map(([key, s]) => {
        const a = actual.get(key);
        const hired = a?.hired ?? 0;
        return {
          shopShortName: s.shopShortName,
          target: s.shortage,
          hired,
          rate: s.shortage > 0 ? hired / s.shortage : null,
          urgent: s.urgent,
          applied: a?.applied ?? 0,
          lastWeekApplied: a?.lastWeekApplied ?? 0,
          prevWeekApplied: a?.prevWeekApplied ?? 0,
          pool: a?.pool ?? 0,
          scheduled: a?.scheduled ?? 0,
        };
      })
      .filter((r) => r.target > 0 || r.applied > 0)
      // 充足率が低い校舎から。同率なら目標が大きい方を先に。
      .sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1) || b.target - a.target);
  }, [apps, plan, weekKeys]);

  /**
   * 応募はあるのに不足人数マスタに校舎が無いもの。
   * この応募は充足状況の表に出てこないので、取りこぼしとして知らせる。
   */
  const unplannedShops = useMemo(() => {
    if (!plan) return [];
    const known = shortageLookup(plan);
    const counts = new Map<string, number>();
    for (const a of apps) {
      if (known.has(normalizeShopKey(a.shopShortName))) continue;
      counts.set(a.shopShortName, (counts.get(a.shopShortName) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([shopShortName, count]) => ({ shopShortName, count }))
      .sort((a, b) => b.count - a.count);
  }, [apps, plan]);

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

  const handleExportWorkbook = useCallback(() => {
    downloadWorkbook(buildWorkbookSheets(apps, plan), `採用モニタリング_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [apps, plan]);

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

  const lastWeekLabel = trend[trend.length - 1]?.week.label ?? "";

  /** 集計している期間。ファネルなどが何を対象にしているかを示すのに使う。 */
  const periodLabel = useMemo(() => {
    if (apps.length === 0) return "全期間";
    const dates = apps.map((a) => a.receivedDate).sort();
    const j = (d: string) => d.replace(/^\d{4}-/, "").replace("-", "/");
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
              <span className="hidden text-xs sm:inline" style={{ color: "var(--text-muted)" }}>
                正社員を扱い始めたら、ここで切り替えて同じ画面で見られます
              </span>
            </div>

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
              />
              <StatTile label="4週平均の応募" value={summary.avg4w.toFixed(1)} unit="件/週" />
              <StatTile label="選考中プール" value={summary.activePool} unit="件" hint="未対応〜面接結果待ち" />
              <StatTile label="面接待ち" value={summary.interviewScheduled} unit="件" hint="日程確定済み" />
              <StatTile
                label="採用"
                value={summary.hired}
                unit="件"
                tone={summary.hired > 0 ? "good" : "neutral"}
                hint={`応募からの採用率 ${(summary.hireRate * 100).toFixed(1)}%`}
                className="col-span-2 lg:col-span-1"
              />
            </div>

            <Card title="週次の応募数" subtitle="応募受付日ベース。棒に触れるとその週の内訳が出ます。">
              <WeeklyTrendChart points={trend} />
            </Card>

            <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
              <Card title="いまのプール（選考ステータス別）" subtitle="各段階に何人溜まっているか">
                <StagePoolChart rows={pool} total={apps.length} />
              </Card>

              <Card title="通過ファネル" subtitle={`応募がどこで落ちているか（${periodLabel}の全応募 ${apps.length}件）`}>
                <FunnelChart steps={funnelSteps} />
              </Card>
            </div>
          </div>

          {/* 充足状況 */}
          <div className={`space-y-4 sm:space-y-5 ${section === "plan" ? "" : "hidden sm:block"}`}>
            {plan && planVsActual.length > 0 ? (
              <Card
                title="校舎ごとの充足状況"
                subtitle={`採用目標 計${totalShortage(plan)}名に対する採用実績。充足率が低い校舎から並べています。`}
              >
                <PlanVsActualTable rows={planVsActual} />
                {unplannedShops.length > 0 && (
                  <p className="mt-3 text-[11px]" style={{ color: "var(--status-serious)" }}>
                    不足人数マスタに無い校舎の応募が{unplannedShops.reduce((a, b) => a + b.count, 0)}件あります（
                    {unplannedShops.map((u) => `${u.shopShortName} ${u.count}件`).join(" / ")}
                    ）。この表には出てきません。
                  </p>
                )}
              </Card>
            ) : (
              <Card title="校舎ごとの充足状況">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  不足人数マスタが未登録です。右上の「その他」から読み込むと、校舎ごとの充足率が出ます。
                </p>
              </Card>
            )}
          </div>

          {/* 校舎別応募 */}
          <div className={`space-y-4 sm:space-y-5 ${section === "shops" ? "" : "hidden sm:block"}`}>
            <Card
              title={`${DIMENSION_LABEL[dimension]}ごとの週次推移`}
              subtitle="直近12週。色が濃いほど応募が多い週です。"
              actions={
                <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
                  {DIMENSIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => setDimension(d)}
                      className="shrink-0 rounded-lg border px-2 py-1 text-xs"
                      style={{
                        borderColor: d === dimension ? "var(--series-1)" : "var(--hairline)",
                        color: d === dimension ? "var(--series-1)" : "var(--text-secondary)",
                        fontWeight: d === dimension ? 600 : 400,
                      }}
                      aria-pressed={d === dimension}
                    >
                      {DIMENSION_LABEL[d]}
                    </button>
                  ))}
                </div>
              }
            >
              <WeeklyMatrixTable matrix={matrix} dimensionLabel={DIMENSION_LABEL[dimension]} />
            </Card>

            <Card title={`${DIMENSION_LABEL[dimension]}ごとの選考状況`} subtitle="累計と直近週、そして選考のどこまで進んでいるか">
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
