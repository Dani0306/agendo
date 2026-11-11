import type { BusyPeriod, Schedule } from "@/lib/booking/availability";

export type Service = { id: string; name: string; durationMinutes: number };

export type StoredBooking = {
  id: string;
  resourceId: string;
  resourceName: string;
  serviceId: string;
  serviceName: string;
  serviceDurationMinutes: number;
  start: Date;
  end: Date;
};

export type BookingRequest = {
  tenantId: string;
  customerId: string;
  serviceId: string;
  resourceId: string;
  start: Date;
  end: Date;
};

export type BookingScope = { tenantId: string; customerId: string; bookingId: string };

/**
 * The tools' only way to the data. Every method takes the tenant from the server. A
 * null from a write means Postgres refused the slot (23P01), a normal result.
 */
export type BookingStore = {
  catalog(tenantId: string): Promise<{ schedule: Schedule; services: Service[] }>;
  busyPeriods(tenantId: string, from: Date, to: Date): Promise<BusyPeriod[]>;
  upcomingBookings(tenantId: string, customerId: string, now: Date): Promise<StoredBooking[]>;
  insertBooking(request: BookingRequest): Promise<StoredBooking | null>;
  moveBooking(scope: BookingScope, target: { resourceId: string; start: Date; end: Date }): Promise<StoredBooking | null>;
  cancelBooking(scope: BookingScope): Promise<boolean>;
  markHandoff(tenantId: string, conversationId: string): Promise<void>;
};
