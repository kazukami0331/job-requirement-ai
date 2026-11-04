import Link from "next/link";
import { loadPersonas } from "@/lib/adops/config";
import { Badge, Card, LinkButton, Notice, PageTitle, notices } from "@/components/admin/ui";

export default async function PersonasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const personas = await loadPersonas();
  return (
    <>
      <PageTitle sub="狙う求職者像です。動機・不安・響く言葉を、広告と LP の文章づくりに使います。">ペルソナ</PageTitle>
      <Notice {...n} />
      <Card actions={<LinkButton href="/admin/personas/new">ペルソナを追加</LinkButton>}>
        <ul className="divide-y divide-slate-100">
          {personas.value.map((p) => (
            <li key={p.id} className="py-3">
              <Link href={`/admin/personas/${encodeURIComponent(p.id)}`} className="font-semibold text-blue-800 hover:underline">
                {p.name}
              </Link>
              {p.language && p.language !== "ja" ? (
                <span className="ml-2">
                  <Badge tone="blue">{p.language}</Badge>
                </span>
              ) : null}
              <p className="mt-1 text-sm text-slate-600">{p.summary}</p>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
