import React from 'react';
import ReactDOM from 'react-dom/client';
import { Bell, CalendarDays, ChevronRight, CircleDollarSign, Clock3, Home, MapPin, Navigation, Phone, ShieldAlert, UserRound } from 'lucide-react';
import './styles.css';

function App(){return <div className="phone-app">
  <header><div><p>下午好，安然</p><h1>愿你今天服务顺利</h1></div><button><Bell size={19}/><i/></button></header>
  <main>
    <section className="status-card"><div className="status-top"><div><span className="dot"/>今日接单中</div><label><input type="checkbox" defaultChecked/><i/></label></div><div className="numbers"><div><strong>3</strong><span>今日订单</span></div><div><strong>¥428</strong><span>预计收入</span></div><div><strong>4.9</strong><span>服务评分</span></div></div><small>开发预览 · 数据并非真实经营记录</small></section>
    <section className="section-head"><div><h2>下一单</h2><p>请预留充足通勤时间</p></div><span>14:30 开始</span></section>
    <article className="next-order"><div className="accent"/><div className="order-top"><span>已出发</span><small>订单 ZY…0025</small></div><h3>肩颈舒缓 <em>60 分钟</em></h3><div className="route"><div><i/><span/><i/></div><p><b>当前所在区域</b><small>约 18 分钟 · 位置仅前台更新</small><b>金水区 · 服务地址接单后可见</b></p></div><div className="order-actions"><button><Phone size={16}/>联系客户</button><button className="primary"><Navigation size={16}/>打开导航</button></div></article>
    <section className="quick"><button><CalendarDays/><span>我的排班<small>本周 5 个班次</small></span><ChevronRight/></button><button><CircleDollarSign/><span>收入明细<small>待结算 ¥1,286</small></span><ChevronRight/></button></section>
    <section className="section-head"><div><h2>今日安排</h2><p>2 单待服务 · 1 单已完成</p></div><button>全部订单</button></section>
    <div className="timeline"><article><time>14:30</time><i className="active"/><div><span>即将开始</span><h4>肩颈舒缓 · 60 分钟</h4><p><MapPin size={13}/>金水区 · 约 4.2 km</p></div></article><article><time>16:30</time><i/><div><span>已确认</span><h4>全身释压 SPA · 90 分钟</h4><p><MapPin size={13}/>郑东新区 · 约 6.8 km</p></div></article><article className="muted"><time>11:00</time><i/><div><span>已完成</span><h4>足部舒缓 · 60 分钟</h4><p><Clock3 size={13}/>服务记录已提交</p></div></article></div>
  </main>
  <button className="sos"><ShieldAlert size={17}/><span>SOS</span></button>
  <nav><button className="active"><Home/><span>今日</span></button><button><Clock3/><span>订单</span></button><button><CalendarDays/><span>排班</span></button><button><CircleDollarSign/><span>收入</span></button><button><UserRound/><span>我的</span></button></nav>
</div>}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

