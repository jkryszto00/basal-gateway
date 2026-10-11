import { AccountMenu } from "@/components/account-menu";
import { Logo } from "@/components/logo";
import { NavLink } from "@/components/nav-link";
import { OrgSwitcher } from "@/components/org-switcher";
import { isInstanceAdmin } from "@/lib/admin";
import { myOrganizations, requireOrg } from "@/lib/auth";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const { user, org } = await requireOrg();
  const orgs = await myOrganizations(user.id);
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Logo />
          <OrgSwitcher active={org} orgs={orgs} />
          <nav className="flex gap-1">
            <NavLink href="/dashboard">Overview</NavLink>
            <NavLink href="/dashboard/keys">API keys</NavLink>
            <NavLink href="/dashboard/usage">Usage</NavLink>
            <NavLink href="/dashboard/organization">Organization</NavLink>
            {isInstanceAdmin(user.email) && <NavLink href="/dashboard/admin">Admin</NavLink>}
          </nav>
          <div className="ml-auto">
            <AccountMenu name={user.name} email={user.email} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
