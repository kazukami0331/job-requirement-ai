import { redirect } from "next/navigation";
import { adminPassword, checkPassword, login } from "@/lib/adops/auth";
import { inputCls } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

async function doLogin(form: FormData) {
  "use server";
  if (!checkPassword(String(form.get("password") ?? ""))) redirect("/admin/login?error=1");
  await login();
  redirect("/admin");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const configured = Boolean(adminPassword());
  return (
    <main className="mx-auto max-w-sm px-4 py-20">
      <h1 className="mb-6 text-center text-xl font-bold">広告自動運用 管理画面</h1>
      {!configured ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          パスワードが未設定です。Vercel の環境変数に ADOPS_ADMIN_PASSWORD（またはレポートと同じ ADOPS_REPORT_PASSWORD）を設定してください。
        </p>
      ) : (
        <form action={doLogin} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error ? <p className="mb-4 text-sm text-red-700">パスワードが違います</p> : null}
          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium">パスワード</span>
            <input name="password" type="password" required autoFocus className={inputCls} />
          </label>
          <button type="submit" className="w-full rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            ログイン
          </button>
        </form>
      )}
    </main>
  );
}
