import { Card, CardContent } from "@/components/ui/card";

export function Metric({ value, label }: { value: string; label: string }) {
  return (
    <Card className="metric" size="sm">
      <CardContent>
        <strong>{value}</strong>
        <span>{label}</span>
      </CardContent>
    </Card>
  );
}
