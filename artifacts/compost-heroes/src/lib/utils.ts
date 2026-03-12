import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getFunctionColor(func: string) {
  const normalized = func.toLowerCase();
  if (normalized.includes("airflow")) return "hsl(var(--func-airflow-border))";
  if (normalized.includes("carbon")) return "hsl(var(--func-carbon-border))";
  if (normalized.includes("moisture")) return "hsl(var(--func-moisture-border))";
  if (normalized.includes("nitrogen")) return "hsl(var(--func-nitrogen-border))";
  if (normalized.includes("decomposer") || normalized.includes("fire")) return "hsl(var(--func-decomposer-border))";
  return "hsl(var(--func-action-border))";
}

export function getFunctionBgClass(func: string) {
  const normalized = func.toLowerCase();
  if (normalized.includes("airflow")) return "bg-[hsl(var(--func-airflow-bg))] border-[hsl(var(--func-airflow-border))]";
  if (normalized.includes("carbon")) return "bg-[hsl(var(--func-carbon-bg))] border-[hsl(var(--func-carbon-border))]";
  if (normalized.includes("moisture")) return "bg-[hsl(var(--func-moisture-bg))] border-[hsl(var(--func-moisture-border))]";
  if (normalized.includes("nitrogen")) return "bg-[hsl(var(--func-nitrogen-bg))] border-[hsl(var(--func-nitrogen-border))]";
  if (normalized.includes("decomposer") || normalized.includes("fire")) return "bg-[hsl(var(--func-decomposer-bg))] border-[hsl(var(--func-decomposer-border))]";
  return "bg-[hsl(var(--func-action-bg))] border-[hsl(var(--func-action-border))]";
}
