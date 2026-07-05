import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <main className="loginPage">
      <section className="loginCard">
        <div className="loginTitle">
          <span>Access blocked</span>
          <h1>账号未授权</h1>
          <p>当前登录邮箱不在系统白名单中，无法进入量化系统或调用消耗接口。</p>
        </div>
        <Link className="loginButton" href="/sign-in">
          切换账号
        </Link>
      </section>
    </main>
  );
}
