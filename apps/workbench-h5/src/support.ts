export function emergencyPhoneFromConfig(value: unknown): string {
  const payload = value as {
    data?: { emergencyContact?: { configured?: unknown; phone?: unknown } };
  } | null;
  const contact = payload?.data?.emergencyContact;
  return contact?.configured === true &&
    typeof contact.phone === "string" &&
    /^1[3-9]\d{9}$/.test(contact.phone)
    ? contact.phone
    : "";
}

export function dialEmergencyDuty(
  phone: string,
  navigate: (target: string) => void,
  notify: (message: string) => void,
) {
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    notify("商家紧急值班电话暂不可用，请立即寻求其他帮助。");
    return;
  }
  // Opening the dialer is not proof of connection, dispatch or acknowledgement.
  navigate(`tel:${phone}`);
}
