import { Header } from "@/components/layout";
import { AuthGuard } from "@/components/layout/auth-guard";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex h-screen flex-col">
        <Header />
        <main
          id="main"
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {children}
        </main>
      </div>
    </AuthGuard>
  );
}
