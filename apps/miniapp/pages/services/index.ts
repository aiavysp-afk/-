Page({data:{categories:['全部','按摩舒缓','SPA 放松','足部养护'],active:0,services:[{name:'肩颈舒缓',desc:'肩、颈、背部重点放松',time:'60 分钟',price:'198'},{name:'全身释压 SPA',desc:'全身分区放松与舒缓收尾',time:'90 分钟',price:'268'},{name:'足部舒缓',desc:'足部清洁与非医疗放松',time:'60 分钟',price:'198'}]},select(e:any){this.setData({active:e.currentTarget.dataset.index})}});

