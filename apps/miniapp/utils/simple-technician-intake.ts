const ENTRY = "/pages/technician-onboarding/index";

// This identifier only deduplicates a submission; it is not a login credential.
function submissionKey() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

export function registerSimpleTechnicianIntake() {
  Page({
    closed: false,
    selecting: false,
    submitting: false,
    certificateBase64: "",
    requestKey: "",
    data: {
      name: "",
      phone: "",
      certificatePath: "",
      accepted: false,
      busy: false,
      photoBusy: false,
      submitted: false,
      error: "",
    },
    onLoad() {
      this.closed = false;
      this.requestKey = submissionKey();
    },
    onUnload() {
      this.closed = true;
      this.certificateBase64 = "";
    },
    inputName(event: { detail: { value: string } }) {
      if (this.submitting || this.data.submitted) return;
      this.requestKey = submissionKey();
      this.setData({ name: event.detail.value.slice(0, 40), error: "" });
    },
    inputPhone(event: { detail: { value: string } }) {
      if (this.submitting || this.data.submitted) return;
      this.requestKey = submissionKey();
      this.setData({
        phone: event.detail.value.replace(/\D/g, "").slice(0, 11),
        error: "",
      });
    },
    toggleAccepted() {
      if (!this.submitting && !this.data.submitted)
        this.setData({ accepted: !this.data.accepted, error: "" });
    },
    openPrivacy() {
      wx.navigateTo({ url: "/pages/agreement/index?type=privacy" });
    },
    async chooseCertificate() {
      if (this.submitting || this.selecting || this.data.submitted) return;
      if (!this.data.accepted) {
        this.setData({ error: "请先阅读隐私政策并同意将资料用于入驻审核" });
        return;
      }
      this.selecting = true;
      this.setData({ photoBusy: true, error: "" });
      try {
        const original = await new Promise<string>((resolve, reject) =>
          wx.chooseMedia({
            count: 1,
            mediaType: ["image"],
            sourceType: ["camera", "album"],
            sizeType: ["compressed"],
            success: (result) =>
              result.tempFiles[0]
                ? resolve(result.tempFiles[0].tempFilePath)
                : reject(new Error("未选择照片")),
            fail: (error) =>
              reject(
                new Error(
                  /cancel/i.test(error.errMsg)
                    ? "已取消选择"
                    : "无法读取照片，请检查相册或相机权限",
                ),
              ),
          }),
        );
        if (this.closed) return;
        const path = await new Promise<string>((resolve, reject) =>
          wx.compressImage({
            src: original,
            quality: 80,
            compressedWidth: 1600,
            success: (result) => resolve(result.tempFilePath),
            fail: () =>
              reject(new Error("图片处理失败，请选择JPG或PNG证书照片")),
          }),
        );
        if (this.closed) return;
        const base64 = await new Promise<string>((resolve, reject) =>
          wx.getFileSystemManager().readFile({
            filePath: path,
            encoding: "base64",
            success: (result) => resolve(result.data),
            fail: () => reject(new Error("证书照片读取失败，请重新选择")),
          }),
        );
        if (this.closed) return;
        if (!base64 || base64.length > 699_052)
          throw new Error(
            "照片处理后仍超过512KB，请裁去空白后重新选择，确保文字清楚",
          );
        this.certificateBase64 = base64;
        this.requestKey = submissionKey();
        this.setData({ certificatePath: path });
      } catch (error) {
        if (!this.closed)
          this.setData({
            error: error instanceof Error ? error.message : "证书照片读取失败",
          });
      } finally {
        this.selecting = false;
        if (!this.closed) this.setData({ photoBusy: false });
      }
    },
    async submit() {
      if (
        this.closed ||
        this.submitting ||
        this.selecting ||
        this.data.submitted
      )
        return;
      const name = this.data.name.trim();
      const phone = this.data.phone.trim();
      const error =
        name.length < 2 || name.length > 40
          ? "请填写2至40个字的真实姓名"
          : !/^1[3-9]\d{9}$/.test(phone)
            ? "请填写正确的11位手机号"
            : !this.certificateBase64
              ? "请上传一张清晰的本人证书照片"
              : !this.data.accepted
                ? "请阅读隐私政策并同意将资料用于入驻审核"
                : "";
      if (error) {
        this.setData({ error });
        return;
      }
      this.submitting = true;
      this.setData({ busy: true, error: "" });
      const base = getApp<{ globalData: { apiBaseUrl: string } }>().globalData
        .apiBaseUrl;
      try {
        await new Promise<void>((resolve, reject) =>
          wx.request<{
            data?: { receiptId: string; status: string };
            message?: string;
          }>({
            url: base + "/technician/intake",
            method: "POST",
            timeout: 20_000,
            header: {
              "content-type": "application/json",
              "Idempotency-Key": this.requestKey,
            },
            data: {
              name,
              phone,
              certificateBase64: this.certificateBase64,
              consentAccepted: true,
            },
            success: (result) => {
              if (
                result.statusCode >= 200 &&
                result.statusCode < 300 &&
                result.data?.data?.status === "PENDING_REVIEW" &&
                typeof result.data.data.receiptId === "string" &&
                result.data.data.receiptId
              )
                resolve();
              else
                reject(
                  new Error(
                    result.statusCode === 429
                      ? "提交较频繁，请稍后再试"
                      : result.statusCode === 409
                        ? "本次提交信息已变化，请重新打开表单后提交"
                        : result.statusCode === 413
                          ? "照片过大，请更换更小且清晰的证书照片"
                          : result.statusCode === 503
                            ? "入驻服务暂时繁忙，请保留表单稍后重试"
                            : "提交未完成，请检查资料后重试",
                  ),
                );
            },
            fail: () =>
              reject(
                new Error(
                  "提交结果尚未确认，请保留当前表单并再次提交，系统会避免重复记录",
                ),
              ),
          }),
        );
        if (!this.closed) {
          this.certificateBase64 = "";
          this.setData({
            submitted: true,
            name: "",
            phone: "",
            certificatePath: "",
          });
        }
      } catch (caught) {
        if (!this.closed)
          this.setData({
            error:
              caught instanceof Error ? caught.message : "提交未完成，请重试",
          });
      } finally {
        this.submitting = false;
        if (!this.closed) this.setData({ busy: false });
      }
    },
    backHome() {
      wx.switchTab({ url: "/pages/home/index" });
    },
    onShareAppMessage() {
      return { title: "中原到家 · 技师入驻申请", path: ENTRY };
    },
  });
}
