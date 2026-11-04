import Link from "next/link";
import { loadJobs, loadPersonas } from "@/lib/adops/config";
import { Badge, Card, LinkButton, Notice, PageTitle, notices } from "@/components/admin/ui";

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [jobs, personas] = await Promise.all([loadJobs(), loadPersonas()]);
  const pname = (id: string) => personas.value.find((p) => p.id === id)?.name ?? id;
  return (
    <>
      <PageTitle sub="広告と応募ページに使う求人情報です。給与・待遇はここに書いた事実だけが広告に使われます。">求人</PageTitle>
      <Notice {...n} />
      <Card actions={<LinkButton href="/admin/jobs/new">求人を追加</LinkButton>}>
        {jobs.value.length === 0 ? (
          <p className="text-sm text-slate-600">求人がまだありません。</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {jobs.value.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 py-3">
                <Badge tone={j.active ? "green" : "slate"}>{j.active ? "募集中" : "停止中"}</Badge>
                <Link href={`/admin/jobs/${encodeURIComponent(j.id)}`} className="font-semibold text-blue-800 hover:underline">
                  {j.title}
                </Link>
                <span className="text-sm text-slate-600">
                  {j.location}｜{j.salary?.type} {j.salary?.min?.toLocaleString()}円〜
                </span>
                <span className="text-xs text-slate-500">対象: {j.personas.map(pname).join("・")}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
