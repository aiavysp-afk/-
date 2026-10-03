Page({
  data: {
    services: [
      { id:'neck', name:'肩颈舒缓', subtitle:'久坐之后，让紧绷慢慢松开', duration:'60 分钟', price:'198', badge:'人气之选', tone:'sage' },
      { id:'spa', name:'全身释压 SPA', subtitle:'以温和节奏，找回身体的松弛感', duration:'90 分钟', price:'268', badge:'深度放松', tone:'tea' },
      { id:'foot', name:'足部舒缓', subtitle:'从脚步开始，卸下一天的疲惫', duration:'60 分钟', price:'198', badge:'轻松入门', tone:'clay' }
    ],
    therapists: [
      { name:'安然', level:'资深舒缓师', score:'4.9', tags:['肩颈','SPA'], avatar:'安' },
      { name:'若溪', level:'专业理疗师', score:'4.8', tags:['足部','全身'], avatar:'若' },
      { name:'静宜', level:'金牌服务师', score:'5.0', tags:['SPA','肩颈'], avatar:'静' }
    ]
  },
  chooseAddress(){ wx.showToast({ title:'服务区域尚未配置', icon:'none' }); },
  bookNow(){ wx.showToast({ title:'预约链路开发中', icon:'none' }); },
  callSupport(){ wx.showToast({ title:'客服热线尚未配置', icon:'none' }); }
});

