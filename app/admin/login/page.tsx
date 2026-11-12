import Link from "next/link";
import { login } from "@/app/admin/actions";
import { crmSelect, CrmNotReadyError } from "@/lib/crm";
import AuthCard, { Field } from "@/components/admin/AuthCard";
import { btnCls, inputCls, Notice } from "@/components/admin/bits";
import { ErrorBox } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next = "/admin" } = await searchParams;
  let noStaff = false;
  try {
    noStaff = (await crmSelect<{ id: string }>("crm_staff", "select=id&limit=1")).length === 0;
  } catch (e) {
    if (e instanceof CrmNotReadyError) return <ErrorBox error={e} />;
    return <ErrorBox error={e} />;
  }
  if (noStaff) {
    return (
      <AuthCard title="はじめに" lead="まだ担当者が登録されていません。最初の管理者アカウントを作りましょう。">
        <Link href="/admin/setup" className={btnCls}>管理者アカウントを作る</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="ログイン">
      {error && <Notice kind="error">メールアドレスかパスワードが違います</Notice>}
      <form action={login} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <Field label="メールアドレス">
          <input name="email" type="email" required autoComplete="email" className={inputCls} />
        </Field>
        <Field label="パスワード">
          <input name="password" type="password" required autoComplete="current-password" className={inputCls} />
        </Field>
        <button className={`${btnCls} w-full`}>ログイン</button>
      </form>
      <p className="text-xs text-slate-400">アカウントがない方は、メンバーから招待リンクをもらってください。</p>
    </AuthCard>
  );
}
