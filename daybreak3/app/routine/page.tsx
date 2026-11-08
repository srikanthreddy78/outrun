"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RoutineRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/routines"); }, [router]);
  return null;
}
