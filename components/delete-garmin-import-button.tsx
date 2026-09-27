"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteGarminImportAction } from "@/app/actions/garmin";
import { Button } from "@/components/ui/button";

export function DeleteGarminImportButton({ importId }: { importId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteGarminImportAction(importId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        result.nextImportId !== null
          ? `Garmin import deleted. ${result.pendingCount} staged ${result.pendingCount === 1 ? "dive remains" : "dives remain"}.`
          : "Garmin import deleted.",
      );
      router.refresh();
      router.push(
        result.nextImportId !== null
          ? `/settings/integrations/garmin/imports/${result.nextImportId}`
          : "/settings/integrations",
      );
    });
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={handleDelete} className="w-fit">
      {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      Delete staged import
    </Button>
  );
}
