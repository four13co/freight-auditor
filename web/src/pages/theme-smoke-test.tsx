import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ModeToggle } from '@/components/mode-toggle';
import { APP_NAME } from '@/lib/app-info';

const sampleShipments = [
  { id: 'SH-1001', carrier: 'Acme Freight', status: 'Cleared' },
  { id: 'SH-1002', carrier: 'Beacon Logistics', status: 'Disputed' },
  { id: 'SH-1003', carrier: 'Coastal Cargo', status: 'Cleared' },
];

export default function ThemeSmokeTest() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
        <ModeToggle />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>shadcn/ui smoke test</CardTitle>
          <CardDescription>
            Card, Button, Input, and Table rendering with the project theme.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="carrier">Carrier</Label>
            <Input id="carrier" placeholder="Search carriers…" />
          </div>
          <Button>Primary action</Button>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shipment</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sampleShipments.map((shipment) => (
                <TableRow key={shipment.id}>
                  <TableCell className="font-medium">{shipment.id}</TableCell>
                  <TableCell>{shipment.carrier}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={shipment.status === 'Disputed' ? 'destructive' : 'secondary'}>
                      {shipment.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
