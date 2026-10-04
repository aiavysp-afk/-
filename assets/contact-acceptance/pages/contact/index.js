const {
  openWecomCustomerService,
  callEmergencyDuty,
} = require("../../utils/customer-service");
const contacts = require("../../contacts.public");

Page({
  data: { merchantDutyPhone: contacts.emergencyContact.phone },
  openCustomerService() {
    openWecomCustomerService(contacts.customerService);
  },
  callMerchantDuty() {
    callEmergencyDuty(contacts.emergencyContact);
  },
});
