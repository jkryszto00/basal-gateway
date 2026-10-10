import Link from "next/link";
import { APP_NAME } from "@/lib/app-name";

export function Logo() {
  const [first, ...rest] = APP_NAME.split(" ");
  return (
    <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
      {first}
      {rest.length > 0 && (
        <>
          <span className="text-accent">/</span>
          {rest.join(" ")}
        </>
      )}
    </Link>
  );
}
