import { redirect } from "next/navigation";

// A self-hosted gateway has no marketing page: visitors go to the dashboard, which sends them to sign in.
export default function Home() {
  redirect("/dashboard");
}
