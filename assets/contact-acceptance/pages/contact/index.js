const {
  openWecomCustomerService,
  callEmergencyDuty,
} = require("../../utils/customer-service");
const contacts = require("../../contacts.public");

Page({
  data: {
    merchantDutyPhone: contacts.emergencyContact.phone,
    customerServiceDiagnostic: null,
  },
  openCustomerService() {
    const attempt = (this.customerServiceAttempt || 0) + 1;
    this.customerServiceAttempt = attempt;
    this.setData({ customerServiceDiagnostic: null });
    openWecomCustomerService(
      contacts.customerService,
      undefined,
      (diagnostic) => {
        if (this.customerServiceAttempt !== attempt) return false;
        this.setData({ customerServiceDiagnostic: diagnostic });
      },
    );
  },
  callMerchantDuty() {
    callEmergencyDuty(contacts.emergencyContact);
  },
});
