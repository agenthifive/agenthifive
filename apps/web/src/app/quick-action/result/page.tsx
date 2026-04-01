import { Suspense } from "react";
import ResultContent from "./result-content";

export default function QuickActionResultPage() {
  return (
    <Suspense>
      <ResultContent />
    </Suspense>
  );
}
