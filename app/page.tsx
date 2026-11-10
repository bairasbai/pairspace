'use client';

import { useState, type ReactNode } from 'react';

type IconName =
  | 'home'
  | 'mail'
  | 'images'
  | 'calendar'
  | 'heart'
  | 'arrow'
  | 'lock'
  | 'sparkles'
  | 'plus'
  | 'check'
  | 'menu'
  | 'close'
  | 'pin'
  | 'clock';

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10M9 20v-6h6v6" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>,
    images: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m3 17 5-4 4 3 3-3 6 5" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4m8-4v4M3 10h18" /></>,
    heart: <path d="M20.8 4.7a5.6 5.6 0 0 0-7.9 0l-.9.9-.9-.9a5.6 5.6 0 0 0-7.9 7.9L12 21l8.8-8.4a5.6 5.6 0 0 0 0-7.9Z" />,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    sparkles: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <a className={`brand${light ? ' brand-light' : ''}`} href="#top" aria-label="Рядом — на главную">
      <svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true">
        <path d="M18 30.5C14.6 26.4 5 20.8 5 12.8 5 8.6 8.1 5.5 12 5.5c2.5 0 4.7 1.3 6 3.3 1.3-2 3.5-3.3 6-3.3 3.9 0 7 3.1 7 7.3 0 8-9.6 13.6-13 17.7Z" fill="currentColor" />
        <path d="M18 8.8v21.7" stroke="var(--brand-cut, #f8f5ef)" strokeWidth="1.5" />
      </svg>
      <span>рядом</span>
    </a>
  );
}

const questions = [
  'Какой наш обычный день ты бы хотел повторить?',
  'Что я сделал для тебя недавно — и ты до сих пор улыбаешься?',
  'Какое место ты мечтаешь увидеть именно вдвоём?',
];

const appTabs = [
  { id: 'today', label: 'Сегодня', icon: 'home' as IconName },
  { id: 'letters', label: 'Письма', icon: 'mail' as IconName },
  { id: 'memories', label: 'Моменты', icon: 'images' as IconName },
];

export default function Home() {
  const [activeTab, setActiveTab] = useState('today');
  const [letterOpen, setLetterOpen] = useState(false);
  const [mood, setMood] = useState('');
  const [question, setQuestion] = useState(0);
  const [planSaved, setPlanSaved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <header className="site-header">
        <div className="container nav-wrap">
          <Brand />
          <nav className="desktop-nav" aria-label="Основная навигация">
            <a href="#possibilities">Возможности</a>
            <a href="#experience">Как это работает</a>
            <a href="#principles">Философия</a>
          </nav>
          <a className="nav-cta" href="#demo">Смотреть демо <Icon name="arrow" size={17} /></a>
          <button className="menu-button" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}>
            <Icon name={menuOpen ? 'close' : 'menu'} />
          </button>
        </div>
        {menuOpen && (
          <nav className="mobile-nav" aria-label="Мобильная навигация">
            <a href="#possibilities" onClick={() => setMenuOpen(false)}>Возможности</a>
            <a href="#experience" onClick={() => setMenuOpen(false)}>Как это работает</a>
            <a href="#principles" onClick={() => setMenuOpen(false)}>Философия</a>
            <a href="#demo" onClick={() => setMenuOpen(false)}>Смотреть демо</a>
          </nav>
        )}
      </header>

      <main>
        <section className="hero container" id="top">
          <div className="hero-copy">
            <p className="eyebrow"><span /> Пространство для двоих</p>
            <h1>Всё, что<br /><em>между вами.</em></h1>
            <p className="hero-lead">Письма, планы и маленькие моменты — в одном тёплом месте, которое принадлежит только вам двоим.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#demo">Открыть демо <Icon name="arrow" /></a>
              <a className="text-link" href="#possibilities">Что внутри</a>
            </div>
            <div className="privacy-note">
              <span className="privacy-icon"><Icon name="lock" size={17} /></span>
              <p><strong>Без ленты и лишних глаз.</strong><br />Только вы и ваша история.</p>
            </div>
          </div>

          <div className="hero-stage" id="demo">
            <div className="stage-orbit orbit-one" />
            <div className="stage-orbit orbit-two" />
            <div className="demo-label"><span /> Интерактивный концепт</div>
            <div className="app-shell">
              <div className="app-chrome">
                <div className="chrome-dots"><i /><i /><i /></div>
                <span className="chrome-brand">рядом</span>
                <div className="couple-avatars" aria-label="Алина и Миша"><span>А</span><span>М</span></div>
              </div>
              <div className="app-layout">
                <aside className="app-sidebar">
                  <p className="app-menu-label">НАШЕ МЕСТО</p>
                  <div className="app-tab-list">
                    {appTabs.map((tab) => (
                      <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} type="button" onClick={() => setActiveTab(tab.id)} aria-pressed={activeTab === tab.id}>
                        <Icon name={tab.icon} size={18} /> {tab.label}
                      </button>
                    ))}
                  </div>
                  <div className="sidebar-plan">
                    <Icon name="calendar" size={17} />
                    <span>Ближайший план</span>
                    <strong>Ужин дома</strong>
                    <small>пятница, 19:00</small>
                  </div>
                  <div className="sidebar-profile"><span>А</span><p>Алина<small>на связи</small></p><i /></div>
                </aside>

                <div className="app-main">
                  {activeTab === 'today' && (
                    <div className="app-view today-view">
                      <div className="app-heading">
                        <div><p>ВТОРНИК, 10 НОЯБРЯ</p><h2>Добрый вечер, Алина</h2></div>
                        <button className="icon-button" type="button" aria-label="Добавить запись" onClick={() => { setActiveTab('letters'); setLetterOpen(false); }}><Icon name="plus" size={18} /></button>
                      </div>
                      <div className="countdown-card">
                        <div className="countdown-copy"><p>ДО НАШЕЙ ВСТРЕЧИ</p><div><strong>12</strong><span>дней</span></div><small><Icon name="pin" size={13} /> Казань — Москва</small></div>
                        <div className="date-ticket"><span>НОЯ</span><strong>22</strong><small>воскресенье</small></div>
                        <svg className="countdown-line" viewBox="0 0 220 90" aria-hidden="true"><path d="M-10 80C45 80 24 8 100 20s87 70 140 15" /><circle cx="101" cy="21" r="4" /></svg>
                      </div>
                      <div className="app-card-grid">
                        <article className={`mini-letter-card${letterOpen ? ' is-open' : ''}`}>
                          {letterOpen ? (
                            <>
                              <div className="card-topline"><span>ОТ МИШИ</span><Icon name="mail" size={17} /></div>
                              <p className="letter-snippet">«Пусть сейчас мы в разных городах, мой день всё равно начинается с мысли о тебе…»</p>
                              <button type="button" onClick={() => setActiveTab('letters')}>Читать целиком <Icon name="arrow" size={14} /></button>
                            </>
                          ) : (
                            <>
                              <div className="card-topline"><span>ДЛЯ ТЕБЯ</span><Icon name="mail" size={17} /></div>
                              <div className="envelope-mini"><span /><i /></div>
                              <h3>Есть новое письмо</h3>
                              <button type="button" onClick={() => setLetterOpen(true)} aria-expanded={letterOpen}>Открыть <Icon name="arrow" size={14} /></button>
                            </>
                          )}
                        </article>
                        <article className="mood-card">
                          <div className="card-topline"><span>КАК ТЫ СЕЙЧАС?</span><Icon name="sparkles" size={16} /></div>
                          <p>{mood ? 'Спасибо, что делишься.' : 'Можно без лишних слов.'}</p>
                          <div className="mood-options">
                            {['Спокойно', 'Скучаю', 'Радостно'].map((item) => (
                              <button key={item} type="button" className={mood === item ? 'selected' : ''} onClick={() => setMood(item)} aria-pressed={mood === item}>{mood === item && <Icon name="check" size={12} />}{item}</button>
                            ))}
                          </div>
                        </article>
                      </div>
                      <button className="memory-peek" type="button" onClick={() => setActiveTab('memories')}>
                        <img src="/images/couple-city.jpg" alt="Пара на закате" />
                        <span><small>В ЭТОТ ДЕНЬ, ГОД НАЗАД</small><strong>Наш тихий вечер</strong></span>
                        <Icon name="arrow" size={17} />
                      </button>
                    </div>
                  )}

                  {activeTab === 'letters' && (
                    <div className="app-view letters-view">
                      <div className="app-heading"><div><p>ТОЛЬКО ДЛЯ НАС</p><h2>Наши письма</h2></div><span className="small-count">24</span></div>
                      <article className="open-letter">
                        <div className="letter-meta"><span>10 НОЯБРЯ, 08:00</span><span className="wax-seal">М</span></div>
                        <h3>Алина, доброе утро.</h3>
                        <p>Пусть сейчас мы в разных городах, мой день всё равно начинается с мысли о тебе.</p>
                        <p>Сегодня увидел маленькую кофейню у дома — такую, какую ты любишь. Сохранил её для нашей следующей прогулки.</p>
                        <p className="letter-signature">Скучаю. И уже считаю дни.<br />Твой Миша.</p>
                      </article>
                      <div className="letter-history"><span><Icon name="check" size={14} /> Прочитано</span><small>Ответ можно написать, когда будешь готова</small></div>
                    </div>
                  )}

                  {activeTab === 'memories' && (
                    <div className="app-view memories-view">
                      <div className="app-heading"><div><p>НАША ИСТОРИЯ</p><h2>Моменты</h2></div><span className="small-count">128</span></div>
                      <div className="memory-hero"><img src="/images/couple-together.jpg" alt="Пара держится за руки на берегу моря" /><span>НАШЕ ПЕРВОЕ ПУТЕШЕСТВИЕ</span><strong>Там, где время остановилось</strong><small>Август · 12 фотографий</small></div>
                      <div className="memory-row"><div><img src="/images/couple-city.jpg" alt="Пара смотрит на закат" /><span>Тихий вечер</span></div><div><img src="/images/couple-main.jpg" alt="Сердце из рук на фоне солнца" /><span>Просто о нас</span></div></div>
                    </div>
                  )}
                </div>
              </div>
              <nav className="app-bottom-nav" aria-label="Навигация демо-приложения">
                {appTabs.map((tab) => <button key={tab.id} type="button" className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}><Icon name={tab.icon} size={18} /><span>{tab.label}</span></button>)}
              </nav>
            </div>
            <div className="floating-note"><span><Icon name="heart" size={17} /></span><p>Миша отправил вам тепло<small>только что</small></p></div>
            <div className="floating-photo"><img src="/images/couple-main.jpg" alt="Сердце из рук" /><span>наш маленький момент</span></div>
          </div>
        </section>

        <div className="container product-strip" aria-label="Возможности приложения"><span>Письма</span><i /><span>Воспоминания</span><i /><span>Общие планы</span><i /><span>Вопросы друг другу</span></div>

        <section className="features container" id="possibilities">
          <div className="section-heading">
            <p className="eyebrow"><span /> Не соцсеть. Только вы.</p>
            <h2>Близость складывается<br />из <em>маленьких вещей.</em></h2>
            <p>Не нужно ждать особого повода, чтобы сказать главное.</p>
          </div>
          <div className="bento-grid">
            <article className="feature feature-letters">
              <div className="feature-copy"><span className="feature-number">01</span><h3>Письма с особенным моментом</h3><p>Напишите сейчас, а мы бережно сохраним слова до утра, дня встречи или просто нужного вечера.</p></div>
              <div className="envelope-scene" aria-hidden="true"><div className="paper-letter"><span>Для тебя</span><i /><i /><i /></div><div className="envelope-back" /><div className="envelope-front"><span className="envelope-seal"><Icon name="heart" size={21} /></span></div></div>
            </article>
            <article className="feature feature-memories">
              <img src="/images/couple-city.jpg" alt="Пара проводит время вместе на закате" loading="lazy" />
              <div className="image-shade" />
              <div className="feature-copy"><span className="feature-number">02</span><h3>Ваша история,<br />а не лента</h3><p>Сохраняйте фотографии, места и фразы, к которым захочется вернуться.</p></div>
              <span className="photo-caption">Алина + Миша · наш вечер</span>
            </article>
            <article className="feature feature-questions">
              <div className="feature-copy"><span className="feature-number">03</span><h3>Разговоры, которых не хватало</h3><p>Один хороший вопрос в день — и вы узнаёте друг друга заново.</p></div>
              <div className="question-card"><span>ВОПРОС НА СЕГОДНЯ</span><p>{questions[question]}</p><button type="button" onClick={() => setQuestion((question + 1) % questions.length)}>Другой вопрос <Icon name="arrow" size={16} /></button></div>
            </article>
            <article className="feature feature-plans">
              <div className="feature-copy"><span className="feature-number">04</span><h3>Мечты становятся планами</h3><p>Собирайте идеи свиданий и превращайте «как-нибудь» в конкретный вечер.</p></div>
              <div className="plan-card"><span className="plan-icon"><Icon name="sparkles" /></span><div><small>ИДЕЯ ДЛЯ ВАС</small><strong>Завтрак в любимом месте</strong><span><Icon name="clock" size={14} /> Суббота, без спешки</span></div><button className={planSaved ? 'saved' : ''} type="button" onClick={() => setPlanSaved(!planSaved)} aria-pressed={planSaved}>{planSaved ? <><Icon name="check" size={16} /> В планах</> : <><Icon name="plus" size={16} /> Добавить</>}</button></div>
            </article>
          </div>
        </section>

        <section className="experience" id="experience">
          <div className="container experience-grid">
            <div className="experience-visual">
              <div className="big-photo"><img src="/images/couple-together.jpg" alt="Пара гуляет по берегу моря" loading="lazy" /><span>ваша история продолжается</span></div>
              <div className="distance-card"><span><Icon name="pin" size={18} /></span><p>Между нами сегодня<strong>1 247 км</strong></p><i>и всё равно рядом</i></div>
            </div>
            <div className="experience-copy">
              <p className="eyebrow"><span /> Просто начать</p>
              <h2>Рядом, даже когда между вами <em>километры.</em></h2>
              <ol className="steps">
                <li><span>01</span><div><h3>Создайте своё место</h3><p>Одно пространство для пары. Без публичных профилей, подписчиков и сравнений.</p></div></li>
                <li><span>02</span><div><h3>Начните с малого</h3><p>Первое письмо, ответ на вопрос или фотография обычного, но вашего дня.</p></div></li>
                <li><span>03</span><div><h3>Возвращайтесь друг к другу</h3><p>Новые планы становятся воспоминаниями, а слова — вашей общей историей.</p></div></li>
              </ol>
            </div>
          </div>
        </section>

        <section className="principles container" id="principles">
          <p className="eyebrow"><span /> Наша философия</p>
          <blockquote>«Не помогать говорить чаще.<br />Помогать слышать <em>главное.</em>»</blockquote>
          <div className="principle-list"><span><Icon name="lock" size={18} /> Приватно по умолчанию</span><span><Icon name="heart" size={18} /> Без оценок отношений</span><span><Icon name="sparkles" size={18} /> Забота вместо игры</span></div>
        </section>

        <section className="final-cta container">
          <div className="cta-orbit" />
          <Brand light />
          <h2>Самое важное —<br />не потерять друг друга <em>в буднях.</em></h2>
          <p>Начните с одного письма. Остальная история напишется вдвоём.</p>
          <a className="button button-light" href="#demo">Посмотреть демо ещё раз <Icon name="arrow" /></a>
          <span className="concept-note">Сейчас это интерактивный дизайн-концепт, регистрация ещё не открыта.</span>
        </section>
      </main>

      <footer className="container footer"><Brand /><p>Всё, что между вами.</p><span>Концепт Pairspace · Данные демо вымышленные</span></footer>
    </>
  );
}
