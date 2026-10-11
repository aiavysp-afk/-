"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeLoginReturnPath = safeLoginReturnPath;
const friend_payment_1 = require("./friend-payment");
function safeLoginReturnPath(value) {
    let decoded = value;
    try {
        if (value)
            decoded = decodeURIComponent(value);
    }
    catch {
        return "";
    }
    return decoded === "/pages/technician-onboarding/index" ||
        decoded === "/pages/technician-workbench/index"
        ? decoded
        : (0, friend_payment_1.safeFriendPaymentReturnPath)(value);
}
