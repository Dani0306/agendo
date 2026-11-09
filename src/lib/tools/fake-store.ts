import type { Schedule } from "@/lib/booking/availability";
import type { BookingRequest, BookingStore, Service, StoredBooking } from "./store";

type Row = StoredBooking & { tenantId: string; customerId: string; status: "confirmed" | "cancelled" };

/** An in-memory store for tests. Enforces the exclusion constraint the way Postgres does. */
export function fakeStore(schedule: Schedule, services: Service[]) {
  const rows: Row[] = [];
  const handoffs: string[] = [];
  let nextId = 1;

  const conflicts = (resourceId: string, start: Date, end: Date, exceptId?: string) =>
    rows.some(
      (row) => row.status === "confirmed" && row.id !== exceptId && row.resourceId === resourceId && start < row.end && row.start < end,
    );

  const resourceName = (id: string) => schedule.resources.find((row) => row.id === id)!.name;

  const store: BookingStore = {
    async catalog() {
      return { schedule, services };
    },
    async busyPeriods(tenantId, from, to) {
      return rows
        .filter((row) => row.tenantId === tenantId && row.status === "confirmed" && row.start < to && from < row.end)
        .map(({ resourceId, start, end }) => ({ resourceId, start, end }));
    },
    async upcomingBookings(tenantId, customerId, now) {
      return rows.filter(
        (row) => row.tenantId === tenantId && row.customerId === customerId && row.status === "confirmed" && row.end > now,
      );
    },
    async insertBooking(request: BookingRequest) {
      if (conflicts(request.resourceId, request.start, request.end)) return null;
      const service = services.find((row) => row.id === request.serviceId)!;
      const row: Row = {
        id: `b${nextId++}`,
        tenantId: request.tenantId,
        customerId: request.customerId,
        resourceId: request.resourceId,
        resourceName: resourceName(request.resourceId),
        serviceId: service.id,
        serviceName: service.name,
        serviceDurationMinutes: service.durationMinutes,
        start: request.start,
        end: request.end,
        status: "confirmed",
      };
      rows.push(row);
      return row;
    },
    async moveBooking({ tenantId, customerId, bookingId }, target) {
      const row = rows.find((item) => item.id === bookingId && item.tenantId === tenantId && item.customerId === customerId);
      if (!row || conflicts(target.resourceId, target.start, target.end, bookingId)) return null;
      Object.assign(row, target, { resourceName: resourceName(target.resourceId) });
      return row;
    },
    async cancelBooking({ tenantId, customerId, bookingId }) {
      const row = rows.find(
        (item) => item.id === bookingId && item.tenantId === tenantId && item.customerId === customerId && item.status === "confirmed",
      );
      if (!row) return false;
      row.status = "cancelled";
      return true;
    },
    async markHandoff(_tenantId, conversationId) {
      handoffs.push(conversationId);
    },
  };

  return { store, rows, handoffs };
}
