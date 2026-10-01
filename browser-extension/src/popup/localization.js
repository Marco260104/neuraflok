(() => {
  const keys = [
    'companion', 'refresh', 'stateSearching', 'stateActive', 'statePaused', 'stateMismatch', 'statePreparing',
    'appHint', 'mismatchHint', 'activeHeading', 'noProvider', 'openSupported', 'responding', 'thinking', 'providers',
    'providerCount', 'notDetected', 'sessionActive', 'signIn', 'checking', 'open', 'details', 'app', 'extension',
    'pending', 'footerAuto', 'secureReady', 'providerOpened', 'queryFailed', 'checkOpen', 'openFailed',
    'integratedUnresponsive', 'retry', 'connect', 'noSession', 'signedInTab', 'sessionDetail', 'signInProvider',
    'versionMismatchDetails', 'popupRequired', 'unsupportedProvider', 'activateFailed', 'focusFailed', 'tabUnknown',
    'openRejected', 'navigationError'
  ];
  const catalogs = {
    en: [
      'Browser companion', 'Refresh status', 'Looking for NEURAFLOK…', 'System active', 'Link paused',
      'Extension version mismatch', 'Preparing connection…', 'Open NEURAFLOK on your desktop. The connection will resume when the app is ready.',
      'The extension version does not match. Restart NEURAFLOK to load its bundled version, then reopen the integrated browser.',
      'ACTIVE TAB', 'No provider', 'Open a supported provider page.', 'Responding', 'Thinking', 'Providers',
      '{0} of {1} active', 'Not detected', 'Session active', 'Sign in', 'Checking', 'Open', 'Connection details', 'App',
      'Extension', 'Pending items', 'Status updates automatically.', 'Secure connection is ready.', '{0} is open in the browser.',
      'Could not check the connection', 'Check that NEURAFLOK and your browser are open.', 'Could not open {0}: {1}',
      'The integrated browser did not respond. Restart NEURAFLOK and try again.', 'Retry', 'Connect', 'No session',
      'Signed in on this tab.', 'Session {0}…', 'Sign in on the provider page to continue.',
      'NEURAFLOK v{0} · extension v{1} · protocols {2} / {3}', 'This request did not come from the NEURAFLOK panel.',
      'This provider is unavailable.', 'The browser could not activate the existing tab.',
      'The page opened, but NEURAFLOK could not focus its window.', 'The browser did not confirm the new tab.',
      'The browser rejected the new tab.', 'Navigation error.'
    ],
    es: [
      'Compañero de navegador', 'Actualizar estado', 'Buscando NEURAFLOK…', 'Sistema activo', 'Enlace pausado',
      'La versión de la extensión no coincide', 'Preparando enlace…', 'Abre NEURAFLOK en el escritorio. El enlace se restablece cuando la app está lista.',
      'La versión de la extensión no coincide. Reinicia NEURAFLOK para cargar la versión incluida y vuelve a abrir el navegador integrado.',
      'PESTAÑA ACTIVA', 'Sin proveedor', 'Abre una página de proveedor compatible.', 'Respondiendo', 'Pensando', 'Proveedores',
      '{0} de {1} activos', 'No detectado', 'Sesión activa', 'Inicia sesión', 'Comprobando', 'Abrir', 'Detalles del enlace', 'App',
      'Extensión', 'Elementos pendientes', 'El estado se actualiza automáticamente.', 'El enlace seguro está disponible.', '{0} está abierto en el navegador.',
      'No se pudo consultar el enlace', 'Comprueba que NEURAFLOK y el navegador estén abiertos.', 'No se pudo abrir {0}: {1}',
      'El navegador integrado no respondió. Reinicia NEURAFLOK y vuelve a intentarlo.', 'Reintentar', 'Conectar', 'Sin sesión',
      'Cuenta iniciada en esta pestaña.', 'Sesión {0}…', 'Inicia sesión en la página del proveedor para continuar.',
      'NEURAFLOK v{0} · extensión v{1} · protocolos {2} / {3}', 'La petición no provino del panel de NEURAFLOK.',
      'Ese proveedor no está disponible.', 'El navegador no pudo activar la pestaña existente.',
      'La página se abrió, pero NEURAFLOK no pudo traer su ventana al frente.', 'El navegador no confirmó la nueva pestaña.',
      'El navegador rechazó la apertura de la pestaña.', 'Error de navegación.'
    ],
    de: [
      'Browser-Begleiter', 'Status aktualisieren', 'NEURAFLOK wird gesucht…', 'System aktiv', 'Verbindung pausiert',
      'Erweiterungsversion stimmt nicht überein', 'Verbindung wird vorbereitet…', 'Öffne NEURAFLOK auf dem Desktop. Die Verbindung wird wiederhergestellt, sobald die App bereit ist.',
      'Die Erweiterungsversion stimmt nicht überein. Starte NEURAFLOK neu und öffne danach den integrierten Browser erneut.',
      'AKTIVER TAB', 'Kein Anbieter', 'Öffne eine unterstützte Anbieterseite.', 'Antwortet', 'Denkt nach', 'Anbieter',
      '{0} von {1} aktiv', 'Nicht erkannt', 'Sitzung aktiv', 'Anmelden', 'Wird geprüft', 'Öffnen', 'Verbindungsdetails', 'App',
      'Erweiterung', 'Ausstehende Elemente', 'Der Status wird automatisch aktualisiert.', 'Sichere Verbindung ist verfügbar.', '{0} ist im Browser geöffnet.',
      'Verbindung konnte nicht geprüft werden', 'Prüfe, ob NEURAFLOK und dein Browser geöffnet sind.', '{0} konnte nicht geöffnet werden: {1}',
      'Der integrierte Browser antwortet nicht. Starte NEURAFLOK neu und versuche es erneut.', 'Erneut versuchen', 'Verbinden', 'Keine Sitzung',
      'In diesem Tab angemeldet.', 'Sitzung {0}…', 'Melde dich auf der Anbieterseite an, um fortzufahren.',
      'NEURAFLOK v{0} · Erweiterung v{1} · Protokolle {2} / {3}', 'Diese Anfrage stammt nicht aus dem NEURAFLOK-Panel.',
      'Dieser Anbieter ist nicht verfügbar.', 'Der Browser konnte den vorhandenen Tab nicht aktivieren.',
      'Die Seite wurde geöffnet, aber NEURAFLOK konnte das Fenster nicht in den Vordergrund holen.', 'Der Browser hat den neuen Tab nicht bestätigt.',
      'Der Browser hat den neuen Tab abgelehnt.', 'Navigationsfehler.'
    ],
    fr: [
      'Compagnon de navigateur', 'Actualiser l’état', 'Recherche de NEURAFLOK…', 'Système actif', 'Lien en pause',
      'Version de l’extension incompatible', 'Préparation de la connexion…', 'Ouvrez NEURAFLOK sur votre ordinateur. La connexion reprendra lorsque l’application sera prête.',
      'La version de l’extension ne correspond pas. Redémarrez NEURAFLOK puis rouvrez le navigateur intégré.',
      'ONGLET ACTIF', 'Aucun fournisseur', 'Ouvrez une page de fournisseur compatible.', 'Réponse en cours', 'Réflexion', 'Fournisseurs',
      '{0} sur {1} actifs', 'Non détecté', 'Session active', 'Se connecter', 'Vérification', 'Ouvrir', 'Détails de la connexion', 'App',
      'Extension', 'Éléments en attente', 'L’état est actualisé automatiquement.', 'La connexion sécurisée est disponible.', '{0} est ouvert dans le navigateur.',
      'Impossible de vérifier la connexion', 'Vérifiez que NEURAFLOK et votre navigateur sont ouverts.', 'Impossible d’ouvrir {0} : {1}',
      'Le navigateur intégré ne répond pas. Redémarrez NEURAFLOK et réessayez.', 'Réessayer', 'Se connecter', 'Aucune session',
      'Session ouverte dans cet onglet.', 'Session {0}…', 'Connectez-vous à la page du fournisseur pour continuer.',
      'NEURAFLOK v{0} · extension v{1} · protocoles {2} / {3}', 'Cette demande ne vient pas du panneau NEURAFLOK.',
      'Ce fournisseur n’est pas disponible.', 'Le navigateur n’a pas pu activer l’onglet existant.',
      'La page est ouverte, mais NEURAFLOK n’a pas pu afficher sa fenêtre.', 'Le navigateur n’a pas confirmé le nouvel onglet.',
      'Le navigateur a refusé le nouvel onglet.', 'Erreur de navigation.'
    ],
    'pt-BR': [
      'Companheiro do navegador', 'Atualizar status', 'Procurando NEURAFLOK…', 'Sistema ativo', 'Conexão pausada',
      'Versão da extensão incompatível', 'Preparando conexão…', 'Abra o NEURAFLOK no computador. A conexão será retomada quando o app estiver pronto.',
      'A versão da extensão não corresponde. Reinicie o NEURAFLOK e abra novamente o navegador integrado.',
      'ABA ATIVA', 'Nenhum provedor', 'Abra uma página de provedor compatível.', 'Respondendo', 'Pensando', 'Provedores',
      '{0} de {1} ativos', 'Não detectado', 'Sessão ativa', 'Entrar', 'Verificando', 'Abrir', 'Detalhes da conexão', 'App',
      'Extensão', 'Itens pendentes', 'O status é atualizado automaticamente.', 'A conexão segura está disponível.', '{0} está aberto no navegador.',
      'Não foi possível verificar a conexão', 'Confira se o NEURAFLOK e o navegador estão abertos.', 'Não foi possível abrir {0}: {1}',
      'O navegador integrado não respondeu. Reinicie o NEURAFLOK e tente novamente.', 'Tentar novamente', 'Conectar', 'Sem sessão',
      'Conta conectada nesta aba.', 'Sessão {0}…', 'Entre na página do provedor para continuar.',
      'NEURAFLOK v{0} · extensão v{1} · protocolos {2} / {3}', 'Esta solicitação não veio do painel do NEURAFLOK.',
      'Este provedor não está disponível.', 'O navegador não conseguiu ativar a aba existente.',
      'A página abriu, mas o NEURAFLOK não conseguiu trazer a janela para frente.', 'O navegador não confirmou a nova aba.',
      'O navegador recusou a nova aba.', 'Erro de navegação.'
    ],
    'pt-PT': [
      'Companheiro do navegador', 'Atualizar estado', 'A procurar NEURAFLOK…', 'Sistema ativo', 'Ligação em pausa',
      'Versão da extensão incompatível', 'A preparar ligação…', 'Abra o NEURAFLOK no computador. A ligação será retomada quando a aplicação estiver pronta.',
      'A versão da extensão não corresponde. Reinicie o NEURAFLOK e volte a abrir o navegador integrado.',
      'SEPARADOR ATIVO', 'Sem fornecedor', 'Abra uma página de fornecedor compatível.', 'A responder', 'A pensar', 'Fornecedores',
      '{0} de {1} ativos', 'Não detetado', 'Sessão ativa', 'Iniciar sessão', 'A verificar', 'Abrir', 'Detalhes da ligação', 'App',
      'Extensão', 'Itens pendentes', 'O estado é atualizado automaticamente.', 'A ligação segura está disponível.', '{0} está aberto no navegador.',
      'Não foi possível verificar a ligação', 'Confirme se o NEURAFLOK e o navegador estão abertos.', 'Não foi possível abrir {0}: {1}',
      'O navegador integrado não respondeu. Reinicie o NEURAFLOK e tente novamente.', 'Tentar novamente', 'Ligar', 'Sem sessão',
      'Sessão iniciada neste separador.', 'Sessão {0}…', 'Inicie sessão na página do fornecedor para continuar.',
      'NEURAFLOK v{0} · extensão v{1} · protocolos {2} / {3}', 'Este pedido não veio do painel do NEURAFLOK.',
      'Este fornecedor não está disponível.', 'O navegador não conseguiu ativar o separador existente.',
      'A página abriu, mas o NEURAFLOK não conseguiu trazer a janela para a frente.', 'O navegador não confirmou o novo separador.',
      'O navegador recusou o novo separador.', 'Erro de navegação.'
    ],
    ru: [
      'Помощник браузера', 'Обновить состояние', 'Поиск NEURAFLOK…', 'Система активна', 'Соединение приостановлено',
      'Версия расширения не совпадает', 'Подготовка соединения…', 'Откройте NEURAFLOK на компьютере. Соединение восстановится, когда приложение будет готово.',
      'Версия расширения не совпадает. Перезапустите NEURAFLOK и снова откройте встроенный браузер.',
      'АКТИВНАЯ ВКЛАДКА', 'Нет провайдера', 'Откройте поддерживаемую страницу провайдера.', 'Отвечает', 'Думает', 'Провайдеры',
      'Активно: {0} из {1}', 'Не обнаружен', 'Сеанс активен', 'Войти', 'Проверка', 'Открыть', 'Сведения о соединении', 'Приложение',
      'Расширение', 'Ожидающие элементы', 'Состояние обновляется автоматически.', 'Защищённое соединение готово.', '{0} открыт в браузере.',
      'Не удалось проверить соединение', 'Убедитесь, что NEURAFLOK и браузер открыты.', 'Не удалось открыть {0}: {1}',
      'Встроенный браузер не отвечает. Перезапустите NEURAFLOK и повторите попытку.', 'Повторить', 'Подключить', 'Нет сеанса',
      'В этой вкладке выполнен вход.', 'Сеанс {0}…', 'Войдите на странице провайдера, чтобы продолжить.',
      'NEURAFLOK v{0} · расширение v{1} · протоколы {2} / {3}', 'Запрос отправлен не из панели NEURAFLOK.',
      'Этот провайдер недоступен.', 'Не удалось активировать существующую вкладку.',
      'Страница открыта, но NEURAFLOK не удалось вывести окно на передний план.', 'Браузер не подтвердил новую вкладку.',
      'Браузер отклонил новую вкладку.', 'Ошибка навигации.'
    ],
    tr: [
      'Tarayıcı yardımcısı', 'Durumu yenile', 'NEURAFLOK aranıyor…', 'Sistem etkin', 'Bağlantı duraklatıldı',
      'Uzantı sürümü eşleşmiyor', 'Bağlantı hazırlanıyor…', 'Masaüstünde NEURAFLOK’i açın. Uygulama hazır olduğunda bağlantı yeniden kurulur.',
      'Uzantı sürümü eşleşmiyor. NEURAFLOK’i yeniden başlatın ve yerleşik tarayıcıyı tekrar açın.',
      'ETKİN SEKME', 'Sağlayıcı yok', 'Desteklenen bir sağlayıcı sayfası açın.', 'Yanıtlıyor', 'Düşünüyor', 'Sağlayıcılar',
      '{1} üzerinden {0} etkin', 'Algılanmadı', 'Oturum etkin', 'Oturum aç', 'Denetleniyor', 'Aç', 'Bağlantı ayrıntıları', 'Uygulama',
      'Uzantı', 'Bekleyen öğeler', 'Durum otomatik olarak güncellenir.', 'Güvenli bağlantı hazır.', '{0} tarayıcıda açık.',
      'Bağlantı denetlenemedi', 'NEURAFLOK’in ve tarayıcının açık olduğunu kontrol edin.', '{0} açılamadı: {1}',
      'Yerleşik tarayıcı yanıt vermedi. NEURAFLOK’i yeniden başlatıp tekrar deneyin.', 'Yeniden dene', 'Bağlan', 'Oturum yok',
      'Bu sekmede oturum açıldı.', 'Oturum {0}…', 'Devam etmek için sağlayıcı sayfasında oturum açın.',
      'NEURAFLOK v{0} · uzantı v{1} · protokoller {2} / {3}', 'Bu istek NEURAFLOK panelinden gelmedi.',
      'Bu sağlayıcı kullanılamıyor.', 'Tarayıcı mevcut sekmeyi etkinleştiremedi.',
      'Sayfa açıldı ancak NEURAFLOK penceresini öne getiremedi.', 'Tarayıcı yeni sekmeyi doğrulamadı.',
      'Tarayıcı yeni sekmeyi reddetti.', 'Gezinme hatası.'
    ],
    vi: [
      'Trình đồng hành trình duyệt', 'Làm mới trạng thái', 'Đang tìm NEURAFLOK…', 'Hệ thống đang hoạt động', 'Kết nối đang tạm dừng',
      'Phiên bản tiện ích không khớp', 'Đang chuẩn bị kết nối…', 'Mở NEURAFLOK trên máy tính. Kết nối sẽ được khôi phục khi ứng dụng sẵn sàng.',
      'Phiên bản tiện ích không khớp. Khởi động lại NEURAFLOK rồi mở lại trình duyệt tích hợp.',
      'THẺ ĐANG HOẠT ĐỘNG', 'Không có nhà cung cấp', 'Mở trang của nhà cung cấp được hỗ trợ.', 'Đang trả lời', 'Đang suy nghĩ', 'Nhà cung cấp',
      'Đang hoạt động: {0}/{1}', 'Chưa phát hiện', 'Phiên đang hoạt động', 'Đăng nhập', 'Đang kiểm tra', 'Mở', 'Chi tiết kết nối', 'Ứng dụng',
      'Tiện ích', 'Mục đang chờ', 'Trạng thái được cập nhật tự động.', 'Kết nối an toàn đã sẵn sàng.', '{0} đang mở trong trình duyệt.',
      'Không thể kiểm tra kết nối', 'Kiểm tra xem NEURAFLOK và trình duyệt đã mở chưa.', 'Không thể mở {0}: {1}',
      'Trình duyệt tích hợp không phản hồi. Khởi động lại NEURAFLOK rồi thử lại.', 'Thử lại', 'Kết nối', 'Không có phiên',
      'Đã đăng nhập trong thẻ này.', 'Phiên {0}…', 'Đăng nhập trên trang nhà cung cấp để tiếp tục.',
      'NEURAFLOK v{0} · tiện ích v{1} · giao thức {2} / {3}', 'Yêu cầu này không đến từ bảng NEURAFLOK.',
      'Nhà cung cấp này không khả dụng.', 'Trình duyệt không thể kích hoạt thẻ hiện có.',
      'Trang đã mở nhưng NEURAFLOK không thể đưa cửa sổ lên trước.', 'Trình duyệt chưa xác nhận thẻ mới.',
      'Trình duyệt đã từ chối thẻ mới.', 'Lỗi điều hướng.'
    ],
    ja: [
      'ブラウザーコンパニオン', '状態を更新', 'NEURAFLOK を検索中…', 'システム稼働中', '接続を一時停止中',
      '拡張機能のバージョンが一致しません', '接続を準備中…', 'デスクトップで NEURAFLOK を開いてください。アプリの準備ができると接続が再開します。',
      '拡張機能のバージョンが一致しません。NEURAFLOK を再起動して、内蔵ブラウザーを開き直してください。',
      'アクティブなタブ', 'プロバイダーなし', '対応するプロバイダーのページを開いてください。', '応答中', '思考中', 'プロバイダー',
      '{1} 件中 {0} 件が有効', '未検出', 'セッション有効', 'ログイン', '確認中', '開く', '接続の詳細', 'アプリ',
      '拡張機能', '保留中の項目', '状態は自動的に更新されます。', '安全な接続を利用できます。', '{0} をブラウザーで開きました。',
      '接続を確認できません', 'NEURAFLOK とブラウザーが起動していることを確認してください。', '{0} を開けませんでした: {1}',
      '内蔵ブラウザーが応答しません。NEURAFLOK を再起動して、もう一度お試しください。', '再試行', '接続', 'セッションなし',
      'このタブでログイン済みです。', 'セッション {0}…', '続行するにはプロバイダーのページにログインしてください。',
      'NEURAFLOK v{0} · 拡張機能 v{1} · プロトコル {2} / {3}', 'このリクエストは NEURAFLOK パネルから送信されていません。',
      'このプロバイダーは利用できません。', '既存のタブをアクティブにできませんでした。',
      'ページは開きましたが、NEURAFLOK のウィンドウを前面に表示できませんでした。', '新しいタブを確認できませんでした。',
      '新しいタブが拒否されました。', '移動エラー。'
    ],
    ko: [
      '브라우저 도우미', '상태 새로 고침', 'NEURAFLOK 검색 중…', '시스템 활성', '연결 일시 중지됨',
      '확장 프로그램 버전이 일치하지 않음', '연결 준비 중…', '데스크톱에서 NEURAFLOK을 여세요. 앱이 준비되면 연결이 다시 시작됩니다.',
      '확장 프로그램 버전이 일치하지 않습니다. NEURAFLOK을 다시 시작한 다음 통합 브라우저를 다시 여세요.',
      '활성 탭', '공급자 없음', '지원되는 공급자 페이지를 여세요.', '응답 중', '생각 중', '공급자',
      '{1}개 중 {0}개 활성', '감지되지 않음', '세션 활성', '로그인', '확인 중', '열기', '연결 세부 정보', '앱',
      '확장 프로그램', '대기 중인 항목', '상태가 자동으로 업데이트됩니다.', '보안 연결을 사용할 수 있습니다.', '브라우저에서 {0}을(를) 열었습니다.',
      '연결을 확인할 수 없습니다', 'NEURAFLOK과 브라우저가 열려 있는지 확인하세요.', '{0}을(를) 열 수 없습니다: {1}',
      '통합 브라우저가 응답하지 않았습니다. NEURAFLOK을 다시 시작하고 다시 시도하세요.', '다시 시도', '연결', '세션 없음',
      '이 탭에서 로그인되었습니다.', '세션 {0}…', '계속하려면 공급자 페이지에서 로그인하세요.',
      'NEURAFLOK v{0} · 확장 프로그램 v{1} · 프로토콜 {2} / {3}', '이 요청은 NEURAFLOK 패널에서 오지 않았습니다.',
      '이 공급자는 사용할 수 없습니다.', '기존 탭을 활성화하지 못했습니다.',
      '페이지는 열렸지만 NEURAFLOK 창을 앞으로 가져오지 못했습니다.', '새 탭이 확인되지 않았습니다.',
      '새 탭이 거부되었습니다.', '탐색 오류.'
    ],
    'zh-CN': [
      '浏览器伴侣', '刷新状态', '正在查找 NEURAFLOK…', '系统已连接', '连接已暂停',
      '扩展程序版本不匹配', '正在准备连接…', '请在桌面上打开 NEURAFLOK。应用就绪后会自动恢复连接。',
      '扩展程序版本不匹配。请重启 NEURAFLOK，然后重新打开内置浏览器。',
      '当前标签页', '没有服务商', '请打开受支持的服务商页面。', '正在回复', '思考中', '服务商',
      '{1} 个中有 {0} 个已连接', '未检测到', '会话已连接', '登录', '正在检查', '打开', '连接详情', '应用',
      '扩展程序', '待处理项目', '状态会自动更新。', '安全连接已就绪。', '已在浏览器中打开 {0}。',
      '无法检查连接', '请确认 NEURAFLOK 和浏览器均已打开。', '无法打开 {0}：{1}',
      '内置浏览器无响应。请重启 NEURAFLOK 后重试。', '重试', '连接', '无会话',
      '此标签页已登录。', '会话 {0}…', '请在服务商页面登录后继续。',
      'NEURAFLOK v{0} · 扩展程序 v{1} · 协议 {2} / {3}', '此请求并非来自 NEURAFLOK 面板。',
      '此服务商不可用。', '无法激活现有标签页。',
      '页面已打开，但 NEURAFLOK 无法将窗口置于前台。', '浏览器未确认新标签页。',
      '浏览器拒绝了新标签页。', '导航错误。'
    ],
    'zh-TW': [
      '瀏覽器伴侶', '重新整理狀態', '正在尋找 NEURAFLOK…', '系統已連線', '連線已暫停',
      '擴充功能版本不相符', '正在準備連線…', '請在桌面開啟 NEURAFLOK。應用程式就緒後會自動恢復連線。',
      '擴充功能版本不相符。請重新啟動 NEURAFLOK，然後重新開啟內建瀏覽器。',
      '作用中的分頁', '沒有服務提供者', '請開啟支援的服務提供者頁面。', '正在回覆', '思考中', '服務提供者',
      '{1} 個中有 {0} 個已連線', '未偵測到', '工作階段已連線', '登入', '正在檢查', '開啟', '連線詳細資料', '應用程式',
      '擴充功能', '待處理項目', '狀態會自動更新。', '安全連線已就緒。', '已在瀏覽器中開啟 {0}。',
      '無法檢查連線', '請確認 NEURAFLOK 和瀏覽器都已開啟。', '無法開啟 {0}：{1}',
      '內建瀏覽器沒有回應。請重新啟動 NEURAFLOK 後再試一次。', '重試', '連線', '沒有工作階段',
      '此分頁已登入。', '工作階段 {0}…', '請先在服務提供者頁面登入以繼續。',
      'NEURAFLOK v{0} · 擴充功能 v{1} · 通訊協定 {2} / {3}', '此要求並非來自 NEURAFLOK 面板。',
      '此服務提供者無法使用。', '無法啟用現有分頁。',
      '頁面已開啟，但 NEURAFLOK 無法將視窗移至前景。', '瀏覽器未確認新分頁。',
      '瀏覽器拒絕了新分頁。', '瀏覽錯誤。'
    ]
  };
  const catalogFor = language => {
    const selected = catalogs[language] || catalogs.en;
    return Object.fromEntries(keys.map((key, index) => [key, selected[index]]));
  };
  const supported = new Set(Object.keys(catalogs));
  const normalize = value => {
    const language = String(value || '').replace('_', '-');
    if (supported.has(language)) return language;
    const base = language.split('-')[0];
    if (supported.has(base)) return base;
    if (base === 'pt') return 'pt-BR';
    if (base === 'zh') return /TW|Hant/i.test(language) ? 'zh-TW' : 'zh-CN';
    return 'en';
  };
  let language = normalize(globalThis.navigator?.language);
  const api = {
    ready: Promise.resolve(),
    language: () => language,
    messages: value => catalogFor(normalize(value)),
    t(key, values = []) {
      const value = catalogFor(language)[key];
      const params = Array.isArray(values) ? values : [values];
      return String(value || key).replace(/\{(\d+)\}/g, (match, index) => params[Number(index)] === undefined ? match : String(params[Number(index)]));
    },
    localizeDocument(doc = globalThis.document) {
      if (!doc) return;
      doc.documentElement.lang = language;
      for (const node of doc.querySelectorAll('[data-i18n]')) node.textContent = api.t(node.dataset.i18n);
      for (const node of doc.querySelectorAll('[data-i18n-title]')) node.title = api.t(node.dataset.i18nTitle);
      for (const node of doc.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', api.t(node.dataset.i18nAriaLabel));
    }
  };
  const setLanguage = value => {
    const next = normalize(value);
    if (next === language) return;
    language = next;
    try { globalThis.dispatchEvent?.(new CustomEvent('neuraflok-language-changed', { detail: { language } })); } catch {}
  };
  try {
    api.ready = Promise.resolve(globalThis.chrome?.storage?.local?.get?.('appLanguage')).then(stored => {
      if (typeof stored?.appLanguage === 'string') setLanguage(stored.appLanguage);
    }).catch(() => undefined);
    globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === 'local' && changes?.appLanguage) setLanguage(changes.appLanguage.newValue);
    });
  } catch {}
  globalThis.NEURAFLOK_I18N = Object.freeze(api);
})();
