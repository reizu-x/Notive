// Dafnote marketing site — no dependencies, no external requests
(function(){
  var menuBtn = document.getElementById('menu-btn');
  var mobileNav = document.getElementById('mobile-nav');
  if(menuBtn && mobileNav){
    menuBtn.addEventListener('click', function(){
      var open = mobileNav.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menuBtn.textContent = open ? '✕' : '☰';
    });
    mobileNav.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(){
        mobileNav.classList.remove('open');
        menuBtn.textContent = '☰';
        menuBtn.setAttribute('aria-expanded','false');
      });
    });
  }

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(function(item){
    var q = item.querySelector('.faq-q');
    if(!q) return;
    q.addEventListener('click', function(){
      var isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(function(o){ o.classList.remove('open'); });
      if(!isOpen) item.classList.add('open');
    });
  });

  // Template tabs
  var tabs = document.querySelectorAll('.tpl-tab');
  var panels = document.querySelectorAll('.tpl-panel');
  tabs.forEach(function(t){
    t.addEventListener('click', function(){
      tabs.forEach(function(x){ x.classList.remove('on'); });
      panels.forEach(function(p){ p.classList.remove('on'); });
      t.classList.add('on');
      var panel = document.querySelector('[data-panel="'+t.getAttribute('data-tpl')+'"]');
      if(panel) panel.classList.add('on');
    });
  });

  // Reveal on scroll
  var revealEls = document.querySelectorAll('.reveal');
  if('IntersectionObserver' in window && revealEls.length){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, {threshold: 0.12});
    revealEls.forEach(function(el){ io.observe(el); });
  } else {
    revealEls.forEach(function(el){ el.classList.add('in'); });
  }

  // Waitlist (local-only demo — stores in localStorage, no network)
  var form = document.getElementById('waitlist-form');
  if(form){
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var email = document.getElementById('waitlist-email');
      var msg = document.getElementById('waitlist-msg');
      var mode = document.getElementById('waitlist-mode');
      if(!email || !email.value || email.value.indexOf('@') < 0){
        if(msg) msg.textContent = 'Please enter a valid email.';
        return;
      }
      try{
        var key = 'dafnote-waitlist';
        var list = JSON.parse(localStorage.getItem(key) || '[]');
        list.push({email: email.value, mode: mode ? mode.value : '', at: new Date().toISOString()});
        localStorage.setItem(key, JSON.stringify(list));
      }catch(e){}
      if(msg) msg.textContent = 'You’re on the list — we’ll email once when cloud launches. Thank you!';
      form.reset();
    });
  }
})();
