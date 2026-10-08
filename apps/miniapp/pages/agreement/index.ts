const AGREEMENTS = {
  user: {
    title: "用户协议",
    sections: [
      {
        title: "服务说明",
        body: "中原到家为用户提供正规上门按摩、SPA、足部舒缓等服务的预约与履约支持。用户应使用真实、有效的联系方式和服务地址。",
      },
      {
        title: "账号使用",
        body: "首次通过微信登录并完成手机号验证后，系统自动创建账号。请妥善保管登录设备，不得冒用他人身份或转让账号。",
      },
      {
        title: "预约与取消",
        body: "平台当前所有技师均免出行费（¥0）。服务价格、时长与取消规则以确认订单页面展示为准，提交前请仔细核对服务项目、时间和地址。",
      },
      {
        title: "文明使用",
        body: "用户与服务人员应相互尊重。平台禁止违法、色情、骚扰、暴力或其他超出正规健康服务范围的要求。",
      },
    ],
  },
  privacy: {
    title: "隐私政策",
    sections: [
      {
        title: "信息收集",
        body: "我们仅在提供服务所必需的范围内处理微信身份标识、经验证的手机号、预约地址、订单与售后记录。",
      },
      {
        title: "信息用途",
        body: "手机号用于登录验证、预约联系、订单履约与售后核验；位置信息用于地址选择、服务范围判断和距离估算。",
      },
      {
        title: "信息保护",
        body: "敏感信息在服务端加密保存。除履约必需、法律要求或获得你的授权外，我们不会向无关第三方公开。",
      },
      {
        title: "用户权利",
        body: "你可以在小程序内查看、修正预约信息，并通过在线客服申请查询、更正或删除依法可处理的个人信息。",
      },
    ],
  },
  service: {
    title: "上门服务公约",
    sections: [
      {
        title: "正规服务",
        body: "平台仅提供正规按摩放松与健康舒缓服务，严禁任何违法违规或违背公序良俗的服务内容。",
      },
      {
        title: "安全履约",
        body: "服务开始前双方应核验订单与人员信息。若发现身份、环境或需求异常，可立即中止服务并联系平台。",
      },
      {
        title: "相互尊重",
        body: "用户应提供安全、适宜的服务环境；服务人员应遵守职业规范、明示服务边界并保护用户隐私。",
      },
      {
        title: "争议处理",
        body: "如发生服务争议，请保留订单与沟通记录，通过在线客服或订单售后入口提交，平台将按规则核验处理。",
      },
    ],
  },
} as const;

Page({
  data: {
    title: AGREEMENTS.user.title,
    sections: AGREEMENTS.user.sections,
  },
  onLoad(options: { type?: string }) {
    const type = options.type as keyof typeof AGREEMENTS;
    const agreement = AGREEMENTS[type] ?? AGREEMENTS.user;
    this.setData({ title: agreement.title, sections: agreement.sections });
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
});
