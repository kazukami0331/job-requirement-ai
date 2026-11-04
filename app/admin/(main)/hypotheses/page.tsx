import Link from "next/link";
import { loadHypotheses, loadPersonas } from "@/lib/adops/config";
import { ANGLE_LABELS } from "@/lib/adops/types";
import { Badge, Card, LinkButton, Notice, PageTitle, notices } from "@/components/admin/ui";

export default async function HypothesesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [hyps, personas] = await Promise.all([loadHypotheses(), loadPersonas()]);
  return (
    <>
      <PageTitle sub="社内で決めた「試したい打ち出し方」です。AI はこの中から選んで広告と LP を作り、成績の良い仮説に多く配分します。仮説の無いペルソナは AI が10種類の訴求から自動で選びます。">
        仮説
      </PageTitle>
      <Notice {...n} />
      {personas.value.map((p) => {
        const list = hyps.value.filter((h) => h.personaId === p.id);
        return (
          <Card key={p.id} title={p.name} actions={<LinkButton href={`/admin/hypotheses/new?persona=${encodeURIComponent(p.id)}`}>仮説を追加</LinkButton>}>
            {list.length === 0 ? (
              <p className="text-sm text-slate-500">仮説はありません（AI が訴求を自動で選びます）</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {list.map((h) => (
                  <li key={h.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={h.active === false ? "slate" : "green"}>{h.active === false ? "停止" : "検証中"}</Badge>
                      <Badge tone="blue">{ANGLE_LABELS[h.angle]}</Badge>
                      <Link href={`/admin/hypotheses/${encodeURIComponent(h.id)}`} className="font-semibold text-blue-800 hover:underline">
                        {h.title}
                      </Link>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{h.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </>
  );
}
