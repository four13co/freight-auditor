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

const sampleShipments = [
  { id: 'SH-1001', carrier: 'Acme Freight', status: 'Cleared' },
  { id: 'SH-1002', carrier: 'Beacon Logistics', status: 'Disputed' },
  { id: 'SH-1003', carrier: 'Coastal Cargo', status: 'Cleared' },
];

/**
 * Content only -- no <main> wrapper. This started as the whole app (#398/
 * #399) and is now embedded in pages/home.tsx's authenticated shell, which
 * owns the page-level <main> landmark.
 */
export default function ThemeSmokeTest() {
  return (
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
  );
}
